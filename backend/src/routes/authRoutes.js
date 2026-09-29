const express = require("express");
const {
  register,
  fieldLogin,
  authorityLogin
} = require("../controllers/authController");

const router = express.Router();

router.post("/register", register);
router.post("/field-login", fieldLogin);
router.post("/authority-login", authorityLogin);

module.exports = router;
