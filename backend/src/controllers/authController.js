const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const AUTHORITY_ROLES = ["mine_official", "corporate_manager", "regulator", "admin"];

function tokenFor(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing.");

  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      name: user.name,
      email: user.email,
      assignedMines: user.assignedMines || []
    },
    secret,
    { expiresIn: "7d" }
  );
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    subsidiary: user.subsidiary || "",
    assignedMines: user.assignedMines || []
  };
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: "Name, email and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must contain at least 6 characters." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail });

    if (exists) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Public registration can never create an authority account.
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      role: "field_officer",
      assignedMines: []
    });

    res.status(201).json({
      token: tokenFor(user),
      user: publicUser(user),
      message: "Field user account created successfully."
    });
  } catch (error) {
    next(error);
  }
}

async function authenticate(email, password) {
  if (!email?.trim() || !password) {
    const error = new Error("Email and password are required.");
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findOne({
    email: email.toLowerCase().trim()
  }).select("+passwordHash");

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  return user;
}

async function fieldLogin(req, res, next) {
  try {
    const user = await authenticate(req.body.email, req.body.password);

    if (user.role !== "field_officer") {
      return res.status(403).json({
        message: "This is an authority account. Use Authority Sign In."
      });
    }

    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
}

async function authorityLogin(req, res, next) {
  try {
    const user = await authenticate(req.body.email, req.body.password);

    if (!AUTHORITY_ROLES.includes(user.role)) {
      return res.status(403).json({
        message: "This is a field-user account. Use Field User Sign In."
      });
    }

    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
}

module.exports = { register, fieldLogin, authorityLogin };
