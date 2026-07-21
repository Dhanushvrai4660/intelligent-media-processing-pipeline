const express = require("express");
const { getAnalytics } = require("../controllers/analyticsController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.get("/", asyncHandler(getAnalytics));

module.exports = router;
