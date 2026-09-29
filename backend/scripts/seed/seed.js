require("dotenv").config({
  path: require("path").join(__dirname, "../../.env")
});

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const Issue = require("../../src/models/issue");
const User = require("../../src/models/User");
const issuesData = require("./issue.json");

async function seed() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is missing.");

  await mongoose.connect(process.env.MONGODB_URI);
  await Issue.deleteMany({});
  await User.deleteMany({});
  await Issue.insertMany(issuesData.map(({ id, ...issue }) => ({ ...issue, issueId: id })));

  const [mineHash, corporateHash, regulatorHash, adminHash] = await Promise.all([
    bcrypt.hash("Mine@123", 12),
    bcrypt.hash("Corporate@123", 12),
    bcrypt.hash("Regulator@123", 12),
    bcrypt.hash("Admin@123", 12)
  ]);

  await User.create([
    {
      name: "Mine Operations Manager",
      email: "manager@khanandrishti.demo",
      passwordHash: mineHash,
      role: "mine_official",
      assignedMines: ["MINE-001"]
    },
    {
      name: "Corporate Governance Manager",
      email: "corporate@khanandrishti.demo",
      passwordHash: corporateHash,
      role: "corporate_manager",
      assignedMines: ["MINE-001", "MINE-002"]
    },
    {
      name: "Regulatory Reviewer",
      email: "regulator@khanandrishti.demo",
      passwordHash: regulatorHash,
      role: "regulator",
      assignedMines: ["MINE-001", "MINE-002"]
    },
    {
      name: "System Administrator",
      email: "admin@khanandrishti.demo",
      passwordHash: adminHash,
      role: "admin",
      assignedMines: ["MINE-001", "MINE-002"]
    }
  ]);

  console.log("KhananDrishti AI database seeded successfully.");
  console.log("Authority accounts: manager@khanandrishti.demo / Mine@123, corporate@khanandrishti.demo / Corporate@123, regulator@khanandrishti.demo / Regulator@123, admin@khanandrishti.demo / Admin@123");
}

seed()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
