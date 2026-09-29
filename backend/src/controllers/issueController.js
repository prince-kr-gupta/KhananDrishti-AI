const mongoose = require("mongoose");
const Issue = require("../models/issue");

const CLOSED_STATUSES = ["Resolved", "Closed"];

const calculateRiskScore = ({ priority, category, status }) => {
  const priorityScore = {
    Low: 20,
    Medium: 40,
    High: 70,
    Critical: 90
  }[priority] || 40;

  const categoryBonus = ["Safety", "Environment", "Compliance"].includes(category) ? 8 : 0;
  const statusAdjustment = CLOSED_STATUSES.includes(status) ? -25 : 0;

  return Math.max(0, Math.min(100, priorityScore + categoryBonus + statusAdjustment));
};

function deriveComplianceSignals(issueLike) {
  const dueDate = issueLike?.dueDate ? new Date(issueLike.dueDate) : null;
  if (!dueDate || Number.isNaN(dueDate.getTime()) || CLOSED_STATUSES.includes(issueLike?.status)) {
    return {
      dueState: "No deadline",
      reminderRequired: false,
      escalationLevel: "None",
      daysToDue: null
    };
  }

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysToDue = Math.ceil((dueDate.getTime() - now.getTime()) / msPerDay);

  if (daysToDue < 0) {
    return {
      dueState: "Overdue",
      reminderRequired: true,
      escalationLevel: Math.abs(daysToDue) >= 7 ? "High" : "Medium",
      daysToDue
    };
  }

  if (daysToDue <= 3) {
    return {
      dueState: "Due soon",
      reminderRequired: true,
      escalationLevel: "Notice",
      daysToDue
    };
  }

  return {
    dueState: "On track",
    reminderRequired: false,
    escalationLevel: "None",
    daysToDue
  };
}

const normalizeIssue = (issue) => {
  const plain = typeof issue.toObject === "function" ? issue.toObject() : issue;
  return {
    ...plain,
    id: plain.issueId,
    ...deriveComplianceSignals(plain)
  };
};

const buildGeoLocation = (coordinates) => {
  if (!coordinates || coordinates.lat == null || coordinates.lng == null) {
    return undefined;
  }

  const lat = Number(coordinates.lat);
  const lng = Number(coordinates.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return undefined;
  }

  return {
    type: "Point",
    coordinates: [lng, lat]
  };
};

function canAccessMine(req, mineId, reportedBy) {
  const role = req.user?.role;
  const assignedMines = Array.isArray(req.user?.assignedMines) ? req.user.assignedMines.filter(Boolean) : [];

  if (["admin", "regulator"].includes(role)) return true;
  if (assignedMines.length > 0) return assignedMines.includes(mineId);
  if (role === "field_officer" && req.user?.name && reportedBy) return reportedBy === req.user.name;
  return role === "field_officer";
}

function applyAccessFilter(req, filter = {}) {
  const role = req.user?.role;
  const assignedMines = Array.isArray(req.user?.assignedMines) ? req.user.assignedMines.filter(Boolean) : [];

  if (["admin", "regulator"].includes(role)) {
    return filter;
  }

  if (assignedMines.length > 0) {
    if (filter.mineId) {
      filter.mineId = assignedMines.includes(filter.mineId) ? filter.mineId : "__forbidden__";
    } else {
      filter.mineId = { $in: assignedMines };
    }
    return filter;
  }

  if (role === "field_officer" && req.user?.name) {
    filter.reportedBy = req.user.name;
    return filter;
  }

  filter.mineId = "__forbidden__";
  return filter;
}

async function listIssues(req, res, next) {
  try {
    const {
      status,
      category,
      priority,
      mineId,
      recordType,
      limit = 500
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (mineId) filter.mineId = mineId;
    if (recordType) filter.recordType = recordType;

    applyAccessFilter(req, filter);

    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const issues = await Issue.find(filter).sort({ createdAt: -1 }).limit(safeLimit).lean();

    res.json(issues.map(normalizeIssue));
  } catch (error) {
    next(error);
  }
}

async function getNearbyIssues(req, res, next) {
  try {
    const { lat, lng, radius = 5000, status, category, priority, mineId, limit = 200 } = req.query;
    const latitude = Number(lat);
    const longitude = Number(lng);
    const maxDistance = Number(radius);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ message: "Invalid latitude or longitude." });
    }

    if (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 50000) {
      return res.status(400).json({ message: "Radius must be between 1 and 50000 meters." });
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const filter = {
      geoLocation: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [longitude, latitude]
          },
          $maxDistance: maxDistance
        }
      }
    };

    if (status) filter.status = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (mineId) filter.mineId = mineId;
    applyAccessFilter(req, filter);

    const issues = await Issue.find(filter).limit(safeLimit).lean();
    res.json(issues.map(normalizeIssue));
  } catch (error) {
    next(error);
  }
}

async function getIssueStats(req, res, next) {
  try {
    const baseFilter = applyAccessFilter(req, {});
    const issues = await Issue.find(baseFilter).lean();

    const total = issues.length;
    const unresolvedIssues = issues.filter((issue) => !CLOSED_STATUSES.includes(issue.status));
    const resolved = issues.filter((issue) => CLOSED_STATUSES.includes(issue.status)).length;
    const critical = unresolvedIssues.filter((issue) => issue.priority === "Critical").length;
    const highRisk = unresolvedIssues.filter((issue) => (issue.riskScore || 0) >= 75).length;
    const overdue = unresolvedIssues.filter((issue) => deriveComplianceSignals(issue).dueState === "Overdue").length;
    const dueSoon = unresolvedIssues.filter((issue) => deriveComplianceSignals(issue).dueState === "Due soon").length;
    const escalated = unresolvedIssues.filter((issue) => ["Medium", "High"].includes(deriveComplianceSignals(issue).escalationLevel)).length;

    const complianceRecords = issues.filter((issue) => issue.category === "Compliance");
    const complianceClosed = complianceRecords.filter((issue) => CLOSED_STATUSES.includes(issue.status)).length;
    const complianceRate = complianceRecords.length ? Math.round((complianceClosed / complianceRecords.length) * 100) : 100;

    const countBy = (key) => Object.entries(
      issues.reduce((acc, issue) => {
        const label = issue[key] || "Unknown";
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ [key === "category" ? "category" : key === "status" ? "status" : "priority"]: label, count }));

    res.json({
      total,
      open: unresolvedIssues.length,
      unresolved: unresolvedIssues.length,
      resolved,
      critical,
      highRisk,
      overdue,
      dueSoon,
      escalated,
      mines: new Set(issues.map((issue) => issue.mineId).filter(Boolean)).size,
      complianceRate,
      categories: countBy("category"),
      statuses: countBy("status"),
      priorities: countBy("priority")
    });
  } catch (error) {
    next(error);
  }
}

async function getIssue(req, res, next) {
  try {
    const issue = await Issue.findOne({
      $or: [
        { issueId: req.params.id },
        ...(mongoose.isValidObjectId(req.params.id) ? [{ _id: req.params.id }] : [])
      ]
    });

    if (!issue) {
      return res.status(404).json({ message: "Governance record not found." });
    }

    if (!canAccessMine(req, issue.mineId, issue.reportedBy)) {
      return res.status(403).json({ message: "You do not have access to this record." });
    }

    res.json(normalizeIssue(issue));
  } catch (error) {
    next(error);
  }
}

async function createIssue(req, res, next) {
  try {
    const payload = { ...req.body };
    if (payload.dueDate === "") delete payload.dueDate;

    if (!canAccessMine(req, payload.mineId, payload.reportedBy || req.user?.name)) {
      return res.status(403).json({ message: "You are not allowed to create records for this mine." });
    }

    const normalizedCoordinates = payload.coordinates || (payload.lat != null && payload.lng != null ? { lat: Number(payload.lat), lng: Number(payload.lng) } : undefined);
    const geoLocation = buildGeoLocation(normalizedCoordinates);

    const issue = await Issue.create({
      ...payload,
      issueId: payload.id,
      reportedBy: payload.reportedBy || req.user?.name || "Field Officer",
      status: payload.status || "Reported",
      coordinates: normalizedCoordinates,
      geoLocation,
      riskScore: payload.riskScore ?? calculateRiskScore(payload),
      auditTrail: [{ action: "created", actor: req.user?.name || req.user?.email || req.user?.sub || payload.reportedBy || "system", note: "Record created" }]
    });

    res.status(201).json(normalizeIssue(issue));
  } catch (error) {
    next(error);
  }
}

async function updateIssue(req, res, next) {
  try {
    const allowed = [
      "title",
      "description",
      "mineId",
      "mineName",
      "subsidiary",
      "zone",
      "recordType",
      "category",
      "priority",
      "status",
      "location",
      "coordinates",
      "regulation",
      "contractorName",
      "observation",
      "correctiveAction",
      "dueDate",
      "metricValue",
      "metricUnit",
      "workerCount",
      "presentCount",
      "assignedTo"
    ];

    const currentIssue = await Issue.findOne({ issueId: req.params.id });
    if (!currentIssue) {
      return res.status(404).json({ message: "Governance record not found." });
    }

    if (!canAccessMine(req, currentIssue.mineId, currentIssue.reportedBy)) {
      return res.status(403).json({ message: "You do not have access to this record." });
    }

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.mineId && !canAccessMine(req, updates.mineId, currentIssue.reportedBy)) {
      return res.status(403).json({ message: "You cannot move a record outside your mine scope." });
    }

    if (updates.coordinates) {
      const geoLocation = buildGeoLocation(updates.coordinates);
      updates.geoLocation = geoLocation;
    }

    if (updates.priority || updates.category || updates.status) {
      updates.riskScore = calculateRiskScore({
        priority: updates.priority ?? currentIssue.priority,
        category: updates.category ?? currentIssue.category,
        status: updates.status ?? currentIssue.status
      });
    }

    currentIssue.set(updates);
    currentIssue.auditTrail = [
      ...(currentIssue.auditTrail || []),
      {
        action: "updated",
        actor: req.user?.name || req.user?.email || req.user?.sub || "system",
        timestamp: new Date(),
        note: Object.keys(updates).join(", ") || "No field changes"
      }
    ];
    await currentIssue.save();

    res.json(normalizeIssue(currentIssue));
  } catch (error) {
    next(error);
  }
}

async function deleteIssue(req, res, next) {
  try {
    const issue = await Issue.findOne({ issueId: req.params.id });
    if (!issue) {
      return res.status(404).json({ message: "Governance record not found." });
    }

    if (!canAccessMine(req, issue.mineId, issue.reportedBy)) {
      return res.status(403).json({ message: "You do not have access to this record." });
    }

    await Issue.deleteOne({ _id: issue._id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getPublicIssue(req, res, next) {
  try {
    const issue = await Issue.findOne({ issueId: req.params.id });
    if (!issue) return res.status(404).json({ message: "Tracking ID not found." });
    const data = normalizeIssue(issue);
    res.json({
      id: data.id,
      mineName: data.mineName,
      zone: data.zone,
      recordType: data.recordType,
      title: data.title,
      category: data.category,
      priority: data.priority,
      status: data.status,
      riskScore: data.riskScore,
      location: data.location,
      coordinates: data.coordinates,
      dueDate: data.dueDate,
      dueState: data.dueState,
      createdAt: data.createdAt,
      assignedTo: data.assignedTo
    });
  } catch (error) { next(error); }
}

async function createPublicIssue(req, res, next) {
  try {
    const payload = { ...req.body };
    if (payload.dueDate === "") delete payload.dueDate;
    const normalizedCoordinates = payload.coordinates || (payload.lat != null && payload.lng != null ? { lat: Number(payload.lat), lng: Number(payload.lng) } : undefined);
    const geoLocation = buildGeoLocation(normalizedCoordinates);
    const issue = await Issue.create({
      ...payload,
      issueId: payload.id,
      status: "Reported",
      assignedTo: "Unassigned",
      reportedBy: payload.reportedBy || "Field Reporter",
      coordinates: normalizedCoordinates,
      geoLocation,
      riskScore: calculateRiskScore(payload),
      auditTrail: [{ action: "created", actor: payload.reportedBy || "public-field-report", note: "Public field report created" }]
    });
    res.status(201).json(normalizeIssue(issue));
  } catch (error) { next(error); }
}

module.exports = {
  listIssues,
  getNearbyIssues,
  getIssueStats,
  getIssue,
  createIssue,
  updateIssue,
  deleteIssue,
  getPublicIssue,
  createPublicIssue
};
