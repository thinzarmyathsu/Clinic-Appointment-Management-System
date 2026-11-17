# Clinic Appointment Management System

A full-stack clinic appointment application built as a group academic project for Republic Polytechnic's C237 module.

## Features
- Patient, doctor and administrator roles
- Appointment booking and appointment status management
- Diagnosis records and related doctor/patient views
- Administrator management screens
- Server-rendered EJS pages and a MySQL database

## Technologies
Node.js, Express.js, EJS, MySQL (`mysql2`), HTML and CSS.

## Live Website
Explore the Clinic Appointment Management System : https://smartclinicappointments.onrender.com/This application was developed as an academic project using Node.js, Express.js, EJS and MySQL.

## Run locally (demonstration only)
1. Install Node.js and MySQL.
2. Create an empty MySQL database and import `database/schema.sql`.
3. Copy the variable names from `.env.example` into your operating system's environment, using **your own** local database settings and a random `SESSION_SECRET`. The `.env.example` file is only a template; this project does not automatically load `.env` files.
4. In the `app` folder run `npm install` then `node app.js`.
5. Visit `http://localhost:3000`.

**Note:** Startup may alter the `diagnosis` table to add a missing request-status column. Use a disposable test database, not production data.

## Security and limitations
- **Academic demonstration only — not production-ready or suitable for storing real patient information.**
- The original student submission stored and compared account passwords in plain text. This educational snapshot preserves those authentication flows; a production application must use salted password hashing (e.g. bcrypt), secure session configuration, access-control review and additional privacy safeguards.
- The original submission embedded a database credential. The public copy replaces it with environment variables. If that credential is still valid, the database owner should rotate it.
- No real patient records, live connection details or working credentials are included.
- This code was extracted from the supplied group submission; it has **not been tested against a running database**.

## Folder structure
- `app/app.js`: server and routes
- `app/views/`: EJS views
- `app/public/`: styles and images
- `database/schema.sql`: database tables
- `.env.example`: names of required environment variables (no real values)

## Attribution
Created as a **team project**. Individual contributions should be described accurately by each team member. Confirm that teammates agree before publishing shared coursework and media assets.
