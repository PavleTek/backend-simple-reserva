const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const authRouter = require("./routes/auth.routes");
const restaurantRouter = require("./routes/restaurant.routes");
const zoneRouter = require("./routes/zone.routes");
const tableRouter = require("./routes/table.routes");
const scheduleRouter = require("./routes/schedule.routes");
const reservationRouter = require("./routes/reservation.routes");
const teamRouter = require("./routes/team.routes");
const adminRouter = require("./routes/admin.routes");
const uploadRouter = require("./routes/upload.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

const envOrigins = process.env.CORS_ORIGINS || "";
const allowedOrigins = envOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (
      allowedOrigins.length === 0 ||
      !origin ||
      allowedOrigins.includes(origin)
    ) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "SimpleReserva API" });
});

app.use("/api/auth", authRouter);
app.use("/api/restaurants", reservationRouter);
app.use("/api/reservations", reservationRouter);
app.use("/api/restaurant", restaurantRouter);
app.use("/api/restaurant/zones", zoneRouter);
app.use("/api/restaurant/tables", tableRouter);
app.use("/api/restaurant/schedules", scheduleRouter);
app.use("/api/restaurant/team", teamRouter);
app.use("/api/restaurant/upload", uploadRouter);
app.use("/api/admin", adminRouter);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`SimpleReserva API running on port ${PORT}`));
