/* eslint-disable no-console */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

const run = async () => {
  await connectDB();

  const email = process.env.DEFAULT_ADMIN_EMAIL || 'admin@loanmanager.com';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@12345';
  const name = process.env.DEFAULT_ADMIN_NAME || 'Super Admin';

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
  } else {
    await User.create({ name, email, password, role: 'admin' });
    console.log('Default admin created:');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    console.log('  Please log in and change this password immediately.');
  }

  await mongoose.connection.close();
  process.exit(0);
};

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
