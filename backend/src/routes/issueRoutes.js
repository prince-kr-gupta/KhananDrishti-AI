const express = require("express");
const {
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  deleteIssue,
  getNearbyIssues,
  getIssueStats,
  getPublicIssue,
  createPublicIssue
} = require("../controllers/issueController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const governanceRoles = ["mine_official", "corporate_manager", "regulator", "admin"];

router.get("/public/:id", getPublicIssue);
router.post("/public", createPublicIssue);

router.get("/", requireAuth, listIssues);
router.get("/nearby", requireAuth, getNearbyIssues);
router.get("/stats", requireAuth, getIssueStats);
router.get("/:id", requireAuth, getIssue);
router.post("/", requireAuth, createIssue);
router.patch("/:id", requireAuth, requireRole(...governanceRoles), updateIssue);
router.delete("/:id", requireAuth, requireRole("admin", "regulator"), deleteIssue);

module.exports = router;
