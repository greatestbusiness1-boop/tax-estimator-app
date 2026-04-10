"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const { estimate } = require("./taxEstimator");

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, "leads.json");
const APP_BASE_URL = process.env.APP_BASE_URL || "https://tax-estimator-app.onrender.com";
const recentLeads = new Map();

// =============================================================================
// EMAIL CONFIG
// =============================================================================

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "greatestbusiness1@gmail.com",
    pass: "mnqe aasn cenb tszu"
  }
});

// =============================================================================
// LEADS FILE HELPERS
// =============================================================================

function readLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    const raw = fs.readFileSync(LEADS_FILE, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("[leads] Read error:", err.message);
    return [];
  }
}

function writeLeads(leads) {
  const tmp = LEADS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2), "utf8");
  fs.renameSync(tmp, LEADS_FILE);
}

function appendLead(lead) {
  const leads = readLeads();
  leads.push(lead);
  writeLeads(leads);
  return lead;
}

// =============================================================================
// GENERAL HELPERS
// =============================================================================

function formatPhoneNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(0, 10);
  if (digits.length !== 10) return phone || "Not provided";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function roundWholeDollar(amount) {
  const n = Number(amount || 0);
  return Math.round(n);
}

function formatWholeDollar(amount) {
  return roundWholeDollar(amount).toLocaleString("en-US");
}

function labelAmount(amount, type) {
  const rounded = roundWholeDollar(amount);

  if (rounded > 0) {
    return `${type} Refund: $${formatWholeDollar(rounded)}`;
  }

  if (rounded < 0) {
    return `${type} Amount You Owe: $${formatWholeDollar(Math.abs(rounded))}`;
  }

  return `${type}: $0`;
}

function buildEstimateDisplay(estimateSummary = {}) {
  const federal = estimateSummary.federal || {};
  const state = estimateSummary.state || {};

  const federalNet = Number(federal.net || 0);
  const stateNet = Number(state.net || 0);
  const combinedNet = federalNet + stateNet;

  let totalLine = "Estimated break-even";

  if (combinedNet > 0) {
    totalLine = `Estimated Total Refund: $${formatWholeDollar(combinedNet)}`;
  } else if (combinedNet < 0) {
    totalLine = `Estimated Total Due: $${formatWholeDollar(Math.abs(combinedNet))}`;
  }

  return {
    totalLine,
    federalLine: labelAmount(federalNet, "Federal"),
    stateLine: labelAmount(stateNet, "State"),
    federalNet,
    stateNet,
    combinedNet
  };
}

function buildLeadEmailMessages(lead) {
  const priority = lead.priority || "low";
  const name = lead.contact?.name || "Client";
  const email = lead.contact?.email || "";
  const phone = lead.contact?.phone || "Not provided";
  const bookingLink = "https://calendly.com/ngmsllc/tax-estimate-review-15-minutes";
  const estimateSummaryLink = `${APP_BASE_URL}/estimate/${lead.leadId}`;

  const estimateDisplay = buildEstimateDisplay(lead.estimateSummary);
  const federal = lead.estimateSummary?.federal || {};
  const state = lead.estimateSummary?.state || {};

  let internalHeadline = "";
  let internalAction = "";
  let clientSubject = "";
  let clientBody = "";

  if (priority === "high") {
    internalHeadline = "HIGH PRIORITY LEAD";
    internalAction = "Recommended action: Review and contact as soon as possible.";

    clientSubject = "Your tax estimate review is ready";
    clientBody =
`Hello ${name},

Thank you for using the tax estimator.

Based on your estimate, there may be opportunities to improve your outcome, reduce what you owe, or confirm you are receiving the maximum refund available.

Summary:
- ${estimateDisplay.totalLine}
- ${estimateDisplay.federalLine}
- ${estimateDisplay.stateLine}

View your estimate summary:
${estimateSummaryLink}

👉 Schedule your 15-minute tax review now:
${bookingLink}

Thank you,
Greatest Business Solution LLC`;
  } else if (priority === "medium") {
    internalHeadline = "MODERATE PRIORITY LEAD";
    internalAction = "Recommended action: Review soon and follow up as appropriate.";

    clientSubject = "Your tax estimate summary";
    clientBody =
`Hello ${name},

Thank you for using the tax estimator.

Summary:
- ${estimateDisplay.totalLine}
- ${estimateDisplay.federalLine}
- ${estimateDisplay.stateLine}

View your estimate summary:
${estimateSummaryLink}

👉 Schedule your 15-minute tax review:
${bookingLink}

Thank you,
Greatest Business Solution LLC`;
  } else {
    internalHeadline = "LOW PRIORITY LEAD";
    internalAction = "Optional follow-up.";

    clientSubject = "Your tax estimate has been received";
    clientBody =
`Hello ${name},

Thank you for using the tax estimator.

Summary:
- ${estimateDisplay.totalLine}
- ${estimateDisplay.federalLine}
- ${estimateDisplay.stateLine}

View your estimate summary:
${estimateSummaryLink}

Thank you,
Greatest Business Solution LLC`;
  }

  const internalSubject = `${internalHeadline} - ${name}`;
  const internalBody =
`${internalHeadline}

Lead ID: ${lead.leadId}
Submitted: ${lead.timestamp}

Contact
- Name: ${name}
- Email: ${email}
- Phone: ${phone}

Summary
- ${estimateDisplay.totalLine}
- ${estimateDisplay.federalLine}
- ${estimateDisplay.stateLine}

Link: ${estimateSummaryLink}

${internalAction}`;

  return {
    internalSubject,
    internalBody,
    clientSubject,
    clientBody
  };
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "ui")));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// POST /api/estimate
// =============================================================================

app.post("/api/estimate", (req, res) => {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({
      ok: false,
      errors: ["Request body is missing or not valid JSON."]
    });
  }

  let engineResult;
  try {
    engineResult = estimate(req.body);
  } catch (err) {
    console.error("[/api/estimate] Engine error:", err);
    return res.status(500).json({
      ok: false,
      errors: ["Internal server error. Please try again or contact support."]
    });
  }

  if (!engineResult.ok) {
    return res.status(400).json({
      ok: false,
      errors: engineResult.errors || ["Validation failed. Please check your inputs."]
    });
  }

  return res.status(200).json({
    ok: true,
    result: engineResult.result
  });
});

// =============================================================================
// POST /api/lead
// =============================================================================

app.post("/api/lead", async (req, res) => {
  const { name, email, phone, priority, taxData, estimateSummary } = req.body;

  const errors = [];

  if (!name || typeof name !== "string" || !name.trim()) {
    errors.push("Full name is required.");
  }

  if (!email || typeof email !== "string" || !email.trim()) {
    errors.push("Email address is required.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    errors.push("Email address format is invalid.");
  }

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  const leadId = `LEAD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const formattedPhone = formatPhoneNumber(phone);

 const lead = {
  leadId,
  timestamp: new Date().toISOString(),
  priority: priority || "low",
  status: "New",
  notes: "",
  contact: {
    name: name.trim(),
    email: email.trim(),
    phone: formattedPhone || null
  },
  taxData: taxData || null,
  estimateSummary: estimateSummary || {}
};

// 🔥 Build summary lines for dashboard
if (lead.estimateSummary) {
  const e = lead.estimateSummary;

  const federal = e.federal?.net || 0;
  const state = e.state?.net || 0;
  const combined = (federal + state);

  lead.estimateSummary.federalLine =
    federal > 0
      ? `Federal Refund: $${Math.round(federal).toLocaleString()}`
      : federal < 0
      ? `Federal Due: $${Math.abs(Math.round(federal)).toLocaleString()}`
      : `Federal: $0`;

  lead.estimateSummary.stateLine =
    state > 0
      ? `State Refund: $${Math.round(state).toLocaleString()}`
      : state < 0
      ? `State Due: $${Math.abs(Math.round(state)).toLocaleString()}`
      : `State: $0`;

  lead.estimateSummary.totalLine =
    combined > 0
      ? `Estimated Total Refund: $${Math.round(combined).toLocaleString()}`
      : combined < 0
      ? `Estimated Total Due: $${Math.abs(Math.round(combined)).toLocaleString()}`
      : `Break-even`;
}


  try {
    appendLead(lead);
recentLeads.set(lead.leadId, lead);

    const emailMessages = buildLeadEmailMessages(lead);

    await transporter.sendMail({
      from: '"Tax Estimator" <greatestbusiness1@gmail.com>',
      to: "greatestbusiness1@gmail.com",
      subject: emailMessages.internalSubject,
      text: emailMessages.internalBody
    });

    await transporter.sendMail({
      from: '"Greatest Business Solution LLC" <greatestbusiness1@gmail.com>',
      to: lead.contact.email,
      subject: emailMessages.clientSubject,
      text: emailMessages.clientBody
    });

    console.log("📧 Smart emails sent (internal + client)");
  } catch (err) {
    console.error("[/api/lead] Save error:", err);
    return res.status(500).json({
      ok: false,
      errors: ["Could not save your request. Please try again."]
    });
  }

  return res.status(201).json({
    ok: true,
    leadId: lead.leadId,
    message: "Your request has been received. A tax professional will contact you within 1 business day."
  });
});

// =============================================================================
// GET /api/estimate-summary/:leadId
// =============================================================================

app.get("/api/estimate-summary/:leadId", (req, res) => {
  const leadId = String(req.params.leadId);

  let lead = recentLeads.get(leadId);

  if (!lead) {
    const leads = readLeads();
    lead = leads.find(l => String(l.leadId) === leadId);
  }

  if (!lead) {
    return res.status(404).json({
      ok: false,
      error: "Estimate not found."
    });
  }

  return res.status(200).json({
    ok: true,
    lead,
    summary: buildEstimateDisplay(lead.estimateSummary)
  });
});

// =============================================================================
// GET /estimate/:leadId (serves HTML page)
// =============================================================================

app.get("/estimate/:leadId", (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "estimate-summary.html"));
});

// =============================================================================
// PATCH /api/leads/:leadId
// =============================================================================

app.patch("/api/leads/:leadId", (req, res) => {
  const { leadId } = req.params;
  const { status, notes } = req.body;

  const leads = readLeads();
  const leadIndex = leads.findIndex(l => l.leadId === leadId);

  if (leadIndex === -1) {
    return res.status(404).json({
      ok: false,
      error: "Lead not found."
    });
  }

  if (typeof status === "string" && status.trim()) {
    leads[leadIndex].status = status.trim();
  }

  if (typeof notes === "string") {
    leads[leadIndex].notes = notes;
  }

  writeLeads(leads);

  return res.status(200).json({
    ok: true,
    lead: leads[leadIndex]
  });
});

// =============================================================================
// GET /leads-dashboard
// =============================================================================

app.get("/leads-dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "leads-dashboard.html"));
});

// =============================================================================
// GET /api/leads
// =============================================================================

app.get("/api/leads", (req, res) => {
  const leads = readLeads();
  return res.status(200).json({
    ok: true,
    count: leads.length,
    leads
  });
});

// =============================================================================
// FALLBACK
// =============================================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "ui", "index.html"));
});

// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================

app.use((err, req, res, next) => {
  console.error("[Unhandled error]", err);
  res.status(500).json({
    ok: false,
    errors: ["An unexpected error occurred. Please try again."]
  });
});

// =============================================================================
// START
// =============================================================================

app.listen(PORT, () => {
  console.log("=".repeat(54));
  console.log("  Greatest Business Solution LLC");
  console.log("  Tax Estimator + Lead Capture Server");
  console.log("=".repeat(54));
  console.log(`  App      : http://localhost:${PORT}`);
  console.log(`  Estimate : POST /api/estimate`);
  console.log(`  Lead     : POST /api/lead`);
  console.log(`  View     : GET  /api/leads`);
  console.log(`  Leads DB : ${LEADS_FILE}`);
  console.log("=".repeat(54));
});

module.exports = app;