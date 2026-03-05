const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const prisma = require("./lib/prisma");
const authRouter = require("./routes/auth.routes");
const restaurantRouter = require("./routes/restaurant.routes");
const zoneRouter = require("./routes/zone.routes");
const tableRouter = require("./routes/table.routes");
const scheduleRouter = require("./routes/schedule.routes");
const reservationRouter = require("./routes/reservation.routes");
const teamRouter = require("./routes/team.routes");
const menuRouter = require("./routes/menu.routes");
const adminRouter = require("./routes/admin.routes");
const uploadRouter = require("./routes/upload.routes");
const billingRouter = require("./routes/billing.routes");
const webhooksRouter = require("./routes/webhooks.routes");
const analyticsRouter = require("./routes/analytics.routes");
const errorHandler = require("./middleware/errorHandler");
const { startReminderJob } = require("./jobs/reminderJob");
const { startDailySummaryJob } = require("./jobs/dailySummaryJob");
const { startTrialReminderJob } = require("./jobs/trialReminderJob");
const { startTrialExpiryJob } = require("./jobs/trialExpiryJob");
const { startGracePeriodExpiryJob } = require("./jobs/gracePeriodExpiryJob");

const app = express();

const envOrigins = process.env.CORS_ORIGINS || "";
const allowedOrigins = envOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// If no CORS_ORIGINS are defined, allow any origin; otherwise use the whitelist
const allowAnyOrigin = allowedOrigins.length === 0;

const corsOptions = {
  origin: (origin, callback) => {
    if (allowAnyOrigin) {
      return callback(null, true);
    }
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    if (process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true); // allow any localhost port in dev
    }
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "SimpleReserva API" });
});

// Redirect after MercadoPago checkout (back_url). MP añade ?preapproval_id=xxx a la URL.
// Usamos path /:restaurantId para evitar que MP corrompa el query.
app.get("/api/redirect-to-billing/:restaurantId", (req, res) => {
  const restaurantId = req.params.restaurantId;
  const preapprovalId = req.query.preapproval_id; // MP añade &preapproval_id=xxx (o ? si es la primera param)
  const appUrl = (process.env.APP_URL || "http://localhost:5174").replace(/\/$/, "");
  const params = new URLSearchParams();
  if (restaurantId) params.set("restaurantId", restaurantId);
  if (preapprovalId) params.set("preapprovalId", String(preapprovalId));
  params.set("returnFromCheckout", "1");
  const target = `${appUrl}/billing?${params.toString()}`;
  res.redirect(302, target);
});

// Fallback: ruta antigua con query (por si hay links guardados)
app.get("/api/redirect-to-billing", (req, res) => {
  let restaurantId = req.query.restaurantId;
  let preapprovalId = req.query.preapproval_id;
  if (restaurantId && typeof restaurantId === "string") {
    const match = restaurantId.match(/^([^?&]+)\?preapproval_id=([^&]+)$/);
    if (match) {
      restaurantId = match[1].trim();
      preapprovalId = preapprovalId || match[2].trim();
    } else {
      restaurantId = restaurantId.split("?")[0].split("&")[0].trim();
    }
  }
  const appUrl = (process.env.APP_URL || "http://localhost:5174").replace(/\/$/, "");
  const params = new URLSearchParams();
  if (restaurantId) params.set("restaurantId", restaurantId);
  if (preapprovalId) params.set("preapprovalId", String(preapprovalId));
  params.set("returnFromCheckout", "1");
  res.redirect(302, `${appUrl}/billing?${params.toString()}`);
});

// Public plans for landing page (no auth)
app.get("/api/public/plans", async (req, res, next) => {
  try {
    const configs = await prisma.planConfig.findMany({
      where: { plan: { in: ["basico", "profesional", "premium"] } },
      orderBy: { plan: "asc" },
      select: {
        plan: true,
        displayName: true,
        description: true,
        priceCLP: true,
        billingFrequency: true,
        billingFrequencyType: true,
        maxLocations: true,
        maxZones: true,
        maxTables: true,
        maxTeamMembers: true,
        smsConfirmations: true,
        smsReminders: true,
        whatsappConfirmations: true,
        whatsappReminders: true,
        whatsappModificationAlerts: true,
        menuPdf: true,
        advancedBookingSettings: true,
        brandingRemoval: true,
        analyticsWeekly: true,
        analyticsMonthly: true,
        crossLocationDashboard: true,
        prioritySupport: true,
      },
    });
    res.json(configs);
  } catch (error) {
    next(error);
  }
});

// Public alias for user-front
app.use("/api/public/restaurants", reservationRouter);
app.use("/api/public/reservations", reservationRouter);

app.use("/api/auth", authRouter);
app.use("/api/restaurants", reservationRouter);
app.use("/api/reservations", reservationRouter);
app.use("/api/restaurant/:restaurantId", restaurantRouter);
app.use("/api/restaurant/:restaurantId", billingRouter);
app.use("/api/restaurant/:restaurantId/zones", zoneRouter);
app.use("/api/restaurant/:restaurantId/tables", tableRouter);
app.use("/api/restaurant/:restaurantId/schedules", scheduleRouter);
app.use("/api/restaurant/:restaurantId/team", teamRouter);
app.use("/api/restaurant/:restaurantId/menus", menuRouter);
app.use("/api/restaurant/:restaurantId/upload", uploadRouter);
app.use("/api/admin", adminRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/webhooks", webhooksRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Recurso no encontrado', path: req.path });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SimpleReserva API running on port ${PORT}`);
  startReminderJob();
  startDailySummaryJob();
  startTrialReminderJob();
  startTrialExpiryJob();
  startGracePeriodExpiryJob();
});
