// ==============================================================================
// 1. SETUP & CONFIGURATION
// ==============================================================================

// Import required packages for the server, database, sessions, and popup messages
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const flash = require('connect-flash');

// Configure these settings locally using environment variables. Never commit actual credentials.
const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SESSION_SECRET'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
    console.error(`Missing environment variables: ${missingEnv.join(', ')}. See .env.example.`);
    process.exit(1);
}

const app = express();

// Middlewares: These handle form data, serve public files (like CSS/images), and manage user sessions
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // Session lasts for 7 days
    })
);
app.use(flash()); // Enables flash messages (temporary popups)

// Global variable accessible in all frontend EJS files to check who is logged in
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});

// Set EJS as the template engine to render HTML
app.set('view engine', 'ejs');

// ==============================================================================
// 2. DATABASE CONNECTION & INITIALIZATION
// ==============================================================================

// Connect to the MySQL database hosted on Azure
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

db.connect((err) => {
    if (err) throw err;
    console.log('Connected to database');
    // Ensure the database has the correct columns when the server boots up
    ensureDiagnosisRequestColumn();
});

// Helper function: Adds the 'patient_request_status' column to the diagnosis table if it's missing
function ensureDiagnosisRequestColumn() {
    const alterSql = `
        ALTER TABLE diagnosis
        ADD COLUMN patient_request_status VARCHAR(30) NOT NULL DEFAULT 'not_requested'
    `;

    db.query(alterSql, (err) => {
        if (err && err.code !== 'ER_DUP_FIELDNAME') {
            console.error('Unable to add diagnosis request status column:', err);
        }
        normalizeDiagnosisRequestStatus();
    });
}

// Helper function: Cleans up any messy or old data in the diagnosis table
function normalizeDiagnosisRequestStatus() {
    const normalizeSql = `
        UPDATE diagnosis
        SET patient_request_status = CASE
            WHEN patient_request_status IS NULL OR patient_request_status = '' THEN 'not_requested'
            WHEN patient_request_status LIKE 'requested|%' THEN 'pending'
            WHEN patient_request_status LIKE 'approved|%' THEN 'approved'
            WHEN patient_request_status LIKE 'rejected|%' THEN 'rejected'
            ELSE patient_request_status
        END
        WHERE patient_request_status IS NULL
           OR patient_request_status = ''
           OR patient_request_status LIKE '%|%'
    `;

    db.query(normalizeSql, (err) => {
        if (err) {
            console.error('Unable to normalize diagnosis request statuses:', err);
        }
    });
}

// ==============================================================================
// 3. SECURITY & HELPER FUNCTIONS
// ==============================================================================

// Formats database user records into a cleaner object for the active session
function mapUserRowToSessionUser(row) {
    return {
        user_id: row.user_id,
        id: row.user_id,
        name: row.name,
        email: row.email,
        contact: row.contact,
        phone: row.contact,
        role: row.role
    };
}

// Security Guard: Blocks access if a user is not logged in at all
function ensureLoggedIn(req, res, next) {
    if (!req.session.user) {
        req.flash('message', 'Please log in first.');
        return res.redirect('/login');
    }
    next();
}

// Security Guard: Blocks access if a user does not have the correct role (e.g., blocking patients from admin pages)
function ensureRole(role) {
    return (req, res, next) => {
        if (!req.session.user) {
            req.flash('message', 'Please log in first.');
            return res.redirect('/login');
        }

        if (req.session.user.role !== role) {
            req.flash('message', 'Access denied.');
            if (req.session.user.role === 'doctor') return res.redirect('/doctordashboard');
            if (req.session.user.role === 'admin') return res.redirect('/admindashboard');
            return res.redirect('/dashboard');
        }

        next();
    };
}

// Helper function: Simplifies rendering basic pages
function renderStatic(viewName) {
    return (req, res) => {
        res.render(viewName, { message: req.flash('message') });
    };
}

// ==============================================================================
// 4. PUBLIC ROUTES & AUTHENTICATION
// ==============================================================================

// Render Homepage and Informational Pages
app.get('/', (req, res) => {
    res.render('index', { message: req.flash('message') });
});

app.get('/about', renderStatic('about'));
app.get('/contact', renderStatic('contact'));
app.get('/reviews', renderStatic('reviews'));
app.get('/location', renderStatic('location'));
app.get('/findus', renderStatic('location'));

// Redirect old .ejs URL structures to the clean routes
app.get('/about.ejs', (req, res) => res.redirect('/about'));
app.get('/contact.ejs', (req, res) => res.redirect('/contact'));
app.get('/reviews.ejs', (req, res) => res.redirect('/reviews'));
app.get('/location.ejs', (req, res) => res.redirect('/location'));

// Show the Registration Page
app.get('/register', (req, res) => {
    res.render('register', { message: req.flash('message') });
});

// Process Registration form submission
app.post('/register', (req, res) => {
    const { name, email, contact, password, role } = req.body;

    if (!name || !email || !contact || !password || !role) {
        req.flash('message', 'Please fill in all required fields.');
        return res.redirect('/register');
    }

    if (!['doctor', 'patient', 'admin'].includes(role)) {
        req.flash('message', 'Invalid role selected.');
        return res.redirect('/register');
    }

    const insertQuery = `
        INSERT INTO users (name, email, contact, password, role)
        VALUES (?, ?, ?, ?, ?)
    `;

    db.query(insertQuery, [name, email, contact, password, role], (err) => {
        if (err) {
            console.error('Error inserting user:', err);
            // Check if email already exists
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'That email is already registered. Please log in.');
            } else {
                req.flash('message', 'An error occurred during registration. Please try again.');
            }
            return res.redirect('/register');
        }

        req.flash('message', 'Registration successful! You can now log in.');
        res.redirect('/login');
    });
});

// Show the Login Page
app.get('/login', (req, res) => {
    res.render('login', { message: req.flash('message'), error: req.flash('error') });
});

// Process Login form submission
app.post('/login', (req, res) => {
    const { email, password, role } = req.body;

    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    // Check credentials against database
    let sql = 'SELECT user_id, name, email, contact, password, role FROM users WHERE email = ? AND password = ?';
    const params = [email, password];

    if (role && ['doctor', 'patient', 'admin'].includes(role)) {
        sql += ' AND role = ?';
        params.push(role);
    }

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error('Login error:', err);
            req.flash('error', 'Database error. Please try again.');
            return res.redirect('/login');
        }

        if (results.length === 0) {
            req.flash('error', 'Invalid email, password, or role.');
            return res.redirect('/login');
        }

        // Login successful: Save user data to session
        req.session.user = mapUserRowToSessionUser(results[0]);

        // Redirect user based on their specific role
        if (req.session.user.role === 'doctor') return res.redirect('/doctordashboard');
        if (req.session.user.role === 'admin') return res.redirect('/admindashboard');
        return res.redirect('/dashboard');
    });
});

// Process Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// ==============================================================================
// 5. PATIENT ROUTES
// ==============================================================================

// Patient Dashboard: Shows a list of their upcoming and past appointments
app.get('/dashboard', ensureRole('patient'), (req, res) => {
    const userId = req.session.user.user_id;

    const apptQuery = `
        SELECT
            a.appointment_id AS id,
            'Smart Clinic' AS clinicName,
            a.appointment_date AS date,
            a.appointment_time AS time,
            d.name AS doctorName,
            a.reason,
            a.status,
            dg.diagnosis,
            dg.prescription,
            dg.doctor_note,
            dg.patient_request_status AS diagnosisRequestStatus
        FROM appointments a
        LEFT JOIN users d ON a.doctor_id = d.user_id
        LEFT JOIN diagnosis dg ON dg.appointment_id = a.appointment_id
        WHERE a.patient_id = ?
        ORDER BY a.appointment_date ASC, a.appointment_time ASC
    `;

    db.query(apptQuery, [userId], (err, apptResults) => {
        if (err) {
            console.error('Patient dashboard query error:', err);
            return res.status(500).send('Database error');
        }

        // Format dates and times beautifully before sending to frontend
        const appointments = apptResults.map((appt) => {
            const dateObj = new Date(appt.date);
            const dateText = dateObj.toLocaleDateString('en-SG', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            const rawTime = (appt.time || '').toString().slice(0, 8);
            const [hh = '00', mm = '00'] = rawTime.split(':');
            const hour = Number(hh);
            const minute = mm.padStart(2, '0');
            const hour12 = hour % 12 || 12;
            const ampm = hour >= 12 ? 'PM' : 'AM';
            const timeText = `${hour12}:${minute} ${ampm}`;
            const requestStatus = (appt.diagnosisRequestStatus || 'not_requested').toString();

            return {
                ...appt,
                displayDateTime: `${dateText}, ${timeText}`,
                requestStatus,
                canViewDiagnosis: !!appt.diagnosis && requestStatus === 'approved',
                canRequestDiagnosis: !!appt.diagnosis && (requestStatus === 'not_requested' || requestStatus === 'rejected'),
                diagnosisPendingApproval: !!appt.diagnosis && requestStatus === 'pending',
                diagnosisWaitingApproval: !!appt.diagnosis && requestStatus === 'not_requested',
                diagnosisRejected: !!appt.diagnosis && requestStatus === 'rejected'
            };
        });

        res.render('customerDashboard', {
            customer: req.session.user,
            appointments,
            message: req.flash('message')
        });
    });
});

// Request access to view a medical diagnosis
app.post('/diagnosis/request/:id', ensureRole('patient'), (req, res) => {
    const appointmentId = req.params.id;
    const patientId = req.session.user.user_id;

    // Check if the diagnosis actually exists and belongs to the patient
    const sql = `
        SELECT
            d.diagnosis_id,
            d.patient_request_status AS requestStatus
        FROM appointments a
        LEFT JOIN diagnosis d ON d.appointment_id = a.appointment_id
        WHERE a.appointment_id = ? AND a.patient_id = ?
    `;

    db.query(sql, [appointmentId, patientId], (err, rows) => {
        if (err) {
            console.error('Error checking diagnosis request:', err);
            req.flash('message', 'Unable to request diagnosis right now.');
            return res.redirect('/dashboard');
        }

        if (rows.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/dashboard');
        }

        if (!rows[0].diagnosis_id) {
            req.flash('message', 'Diagnosis is not available yet.');
            return res.redirect('/dashboard');
        }

        const currentStatus = (rows[0].requestStatus || 'not_requested').toString();

        if (currentStatus === 'approved') {
            req.flash('message', 'Diagnosis is already approved for viewing.');
            return res.redirect('/dashboard');
        }

        if (currentStatus === 'pending') {
            req.flash('message', 'Diagnosis request has already been submitted.');
            return res.redirect('/dashboard');
        }

        // Change the status to 'pending' for admin review
        const updateSql = `
            UPDATE diagnosis
            SET patient_request_status = 'pending'
            WHERE appointment_id = ?
              AND patient_request_status IN ('not_requested', 'rejected')
        `;

        db.query(updateSql, [appointmentId], (updateErr) => {
            if (updateErr) {
                console.error('Error saving diagnosis request:', updateErr);
                req.flash('message', 'Unable to submit diagnosis request.');
                return res.redirect('/dashboard');
            }

            req.flash('message', 'Diagnosis request submitted for admin approval.');
            res.redirect('/dashboard');
        });
    });
});

// View and Edit Patient Profile Details
app.get('/customerInformation', ensureRole('patient'), (req, res) => {
    const userId = req.session.user.user_id;
    const sql = 'SELECT user_id, name, email, contact, role FROM users WHERE user_id = ? AND role = ?';

    db.query(sql, [userId, 'patient'], (err, rows) => {
        if (err) {
            console.error('Error loading profile:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'User profile not found.');
            return res.redirect('/dashboard');
        }

        const customer = { ...rows[0], id: rows[0].user_id, phone: rows[0].contact };
        
        // Update session to keep it fresh
        req.session.user = { ...req.session.user, ...customer, user_id: rows[0].user_id, id: rows[0].user_id, contact: rows[0].contact, phone: rows[0].contact };

        res.render('customerInformation', {
            customer,
            message: req.flash('message')
        });
    });
});

app.post('/customerInformation', ensureRole('patient'), (req, res) => {
    const userId = req.session.user.user_id;
    const { name, email, phone } = req.body;

    if (!name || !email || !phone) {
        req.flash('message', 'Please fill in all required fields.');
        return res.redirect('/customerInformation');
    }

    const sql = 'UPDATE users SET name = ?, email = ?, contact = ? WHERE user_id = ? AND role = ?';

    db.query(sql, [name, email, phone, userId, 'patient'], (err) => {
        if (err) {
            console.error('Error updating profile:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'Email is already in use by another account.');
            } else {
                req.flash('message', 'Failed to update profile. Please try again.');
            }
            return res.redirect('/customerInformation');
        }

        req.session.user = { ...req.session.user, name, email, contact: phone, phone };

        req.flash('message', 'Profile updated successfully.');
        res.redirect('/dashboard');
    });
});

// Show the Appointment Booking page
app.get('/customerAppointment', ensureRole('patient'), (req, res) => {
    // Fetch all available doctors for the dropdown list
    const doctorSql = `SELECT user_id, name FROM users WHERE role = 'doctor' ORDER BY name ASC`;

    db.query(doctorSql, (err, doctors) => {
        if (err) {
            console.error('Error loading doctors:', err);
            return res.status(500).send('Database error');
        }

        res.render('customerAppointment', {
            customer: req.session.user,
            doctors,
            appointment: null, // Null means it's a new booking, not an edit
            formAction: '/bookAppointment',
            message: req.flash('message')
        });
    });
});

// Process a new Appointment Booking
app.post('/bookAppointment', ensureRole('patient'), (req, res) => {
    const patientId = req.session.user.user_id;
    const { doctorId, appointmentDate, appointmentTime, reason } = req.body;

    if (!doctorId || !appointmentDate || !appointmentTime || !reason) {
        req.flash('message', 'Please complete all appointment fields.');
        return res.redirect('/customerAppointment');
    }

    // Verify the selected doctor is valid
    const doctorCheck = 'SELECT user_id FROM users WHERE user_id = ? AND role = ?';
    db.query(doctorCheck, [doctorId, 'doctor'], (doctorErr, doctorRows) => {
        if (doctorErr) {
            console.error('Error checking doctor:', doctorErr);
            return res.status(500).send('Database error');
        }

        if (doctorRows.length === 0) {
            req.flash('message', 'Selected doctor is invalid.');
            return res.redirect('/customerAppointment');
        }

        const insertSql = `
            INSERT INTO appointments (doctor_id, patient_id, appointment_date, appointment_time, reason, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        db.query(insertSql, [doctorId, patientId, appointmentDate, appointmentTime, reason, 'Pending'], (err) => {
            if (err) {
                console.error('Error booking appointment:', err);
                req.flash('message', 'Failed to book appointment. Please try again.');
                return res.redirect('/customerAppointment');
            }

            req.flash('message', 'Appointment booked successfully.');
            res.redirect('/dashboard');
        });
    });
});

// Show the Edit Appointment Page
app.get('/appointment/edit/:id', ensureRole('patient'), (req, res) => {
    const appointmentId = req.params.id;
    const patientId = req.session.user.user_id;

    // Fetch the specific appointment
    const appointmentSql = `
        SELECT
            appointment_id,
            doctor_id,
            DATE_FORMAT(appointment_date, '%Y-%m-%d') AS appointment_date,
            TIME_FORMAT(appointment_time, '%H:%i') AS appointment_time,
            reason,
            status
        FROM appointments
        WHERE appointment_id = ? AND patient_id = ?
    `;

    db.query(appointmentSql, [appointmentId, patientId], (apptErr, apptRows) => {
        if (apptErr) {
            console.error('Error loading appointment for edit:', apptErr);
            return res.status(500).send('Database error');
        }

        if (apptRows.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/dashboard');
        }

        // Fetch doctors again for the dropdown
        const doctorSql = `SELECT user_id, name FROM users WHERE role = 'doctor' ORDER BY name ASC`;

        db.query(doctorSql, (doctorErr, doctors) => {
            if (doctorErr) {
                console.error('Error loading doctors for edit:', doctorErr);
                return res.status(500).send('Database error');
            }

            res.render('customerAppointment', {
                customer: req.session.user,
                doctors,
                appointment: apptRows[0],
                formAction: `/appointment/edit/${appointmentId}`,
                message: req.flash('message')
            });
        });
    });
});

// Process Appointment Update or Cancellation
app.post('/appointment/edit/:id', ensureRole('patient'), (req, res) => {
    const appointmentId = req.params.id;
    const patientId = req.session.user.user_id;
    const { doctorId, appointmentDate, appointmentTime, reason, removeAppointment } = req.body;

    // Logic to cancel/delete the appointment
    if (removeAppointment === '1') {
        const deleteSql = 'DELETE FROM appointments WHERE appointment_id = ? AND patient_id = ?';
        db.query(deleteSql, [appointmentId, patientId], (deleteErr) => {
            if (deleteErr) {
                console.error('Error deleting appointment:', deleteErr);
                req.flash('message', 'Failed to remove appointment.');
                return res.redirect('/appointment/edit/' + appointmentId);
            }

            req.flash('message', 'Appointment removed successfully.');
            return res.redirect('/dashboard');
        });
        return;
    }

    if (!doctorId || !appointmentDate || !appointmentTime || !reason) {
        req.flash('message', 'Please complete all appointment fields.');
        return res.redirect('/appointment/edit/' + appointmentId);
    }

    const doctorUserId = Number(doctorId);
    if (!Number.isInteger(doctorUserId) || doctorUserId <= 0) {
        req.flash('message', 'Selected doctor is invalid.');
        return res.redirect('/appointment/edit/' + appointmentId);
    }

    // Verify doctor validity before updating
    const doctorCheckSql = 'SELECT user_id FROM users WHERE user_id = ? AND role = ?';

    db.query(doctorCheckSql, [doctorUserId, 'doctor'], (doctorErr, doctorRows) => {
        if (doctorErr) {
            console.error('Error validating doctor for update:', doctorErr);
            req.flash('message', 'Failed to update appointment.');
            return res.redirect('/appointment/edit/' + appointmentId);
        }

        if (doctorRows.length === 0) {
            req.flash('message', 'Selected doctor is invalid.');
            return res.redirect('/appointment/edit/' + appointmentId);
        }

        // Only allow edits if the status is NOT 'Completed'
        const updateSql = `
            UPDATE appointments
            SET doctor_id = ?, appointment_date = ?, appointment_time = ?, reason = ?
            WHERE appointment_id = ? AND patient_id = ? AND status <> 'Completed'
        `;

        db.query(updateSql, [doctorUserId, appointmentDate, appointmentTime, reason, appointmentId, patientId], (err, result) => {
            if (err) {
                console.error('Error updating appointment:', err);
                req.flash('message', 'Failed to update appointment.');
                return res.redirect('/appointment/edit/' + appointmentId);
            }

            if (result.affectedRows === 0) {
                req.flash('message', 'Only non-completed appointments can be edited.');
                return res.redirect('/dashboard');
            }

            req.flash('message', 'Appointment updated successfully.');
            res.redirect('/dashboard');
        });
    });
});

// ==============================================================================
// 6. DOCTOR ROUTES
// ==============================================================================

// View and Edit Doctor Profile
app.get('/doctor/profile', ensureRole('doctor'), (req, res) => {
    const userId = req.session.user.user_id;
    const sql = 'SELECT user_id, name, email, contact, password, role FROM users WHERE user_id = ? AND role = ?';

    db.query(sql, [userId, 'doctor'], (err, rows) => {
        if (err) {
            console.error('Error loading doctor profile:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'Doctor profile not found.');
            return res.redirect('/doctordashboard');
        }

        const doctor = { ...rows[0], id: rows[0].user_id, phone: rows[0].contact };

        req.session.user = { ...req.session.user, ...doctor, user_id: rows[0].user_id, id: rows[0].user_id, contact: rows[0].contact, phone: rows[0].contact };

        res.render('doctorProfile', {
            doctor,
            message: req.flash('message')
        });
    });
});

app.post('/doctor/profile', ensureRole('doctor'), (req, res) => {
    const userId = req.session.user.user_id;
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone) {
        req.flash('message', 'Please fill in all required fields.');
        return res.redirect('/doctor/profile');
    }

    // Update password only if a new one is provided
    const hasNewPassword = !!(password && password.trim());
    const sql = hasNewPassword
        ? 'UPDATE users SET name = ?, email = ?, contact = ?, password = ? WHERE user_id = ? AND role = ?'
        : 'UPDATE users SET name = ?, email = ?, contact = ? WHERE user_id = ? AND role = ?';

    const params = hasNewPassword
        ? [name, email, phone, password.trim(), userId, 'doctor']
        : [name, email, phone, userId, 'doctor'];

    db.query(sql, params, (err) => {
        if (err) {
            console.error('Error updating doctor profile:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'Email is already in use by another account.');
            } else {
                req.flash('message', 'Failed to update profile. Please try again.');
            }
            return res.redirect('/doctor/profile');
        }

        req.session.user = { ...req.session.user, name, email, contact: phone, phone };

        req.flash('message', 'Profile updated successfully.');
        res.redirect('/doctordashboard');
    });
});

// Doctor Dashboard: List of patients and appointments assigned to them
app.get('/doctordashboard', ensureRole('doctor'), (req, res) => {
    const doctorId = req.session.user.user_id;
    const search = (req.query.search || '').trim();
    const filter = req.query.filter || 'all';

    let apptQuery = `
        SELECT
            a.appointment_id,
            a.appointment_date,
            a.appointment_time,
            a.reason,
            '' AS consultation_type,
            a.status,
            u.name AS patientName,
            u.contact AS patientContact,
            d.diagnosis_id
        FROM appointments a
        JOIN users u ON u.user_id = a.patient_id
        LEFT JOIN diagnosis d ON d.appointment_id = a.appointment_id
        WHERE a.doctor_id = ?
    `;
    const params = [doctorId];

    // Filter by Search Query
    if (search) {
        apptQuery += ' AND u.name LIKE ?';
        params.push(`%${search}%`);
    }

    // Filter by Date Timeframe
    if (filter === 'today') {
        apptQuery += ' AND a.appointment_date = CURDATE()';
    } else if (filter === 'upcoming') {
        apptQuery += ' AND a.appointment_date >= CURDATE()';
    }

    apptQuery += ' ORDER BY a.appointment_date ASC, a.appointment_time ASC';

    db.query(apptQuery, params, (err, appointments) => {
        if (err) {
            console.error('Error fetching doctor appointments:', err);
            return res.status(500).send('Database error');
        }

        res.render('doctordashboard', {
            doctor: req.session.user,
            appointments,
            search,
            filter,
            message: req.flash('message')
        });
    });
});

// View Specific Appointment Details (from Doctor's POV)
app.get('/doctor/appointment/:id', ensureRole('doctor'), (req, res) => {
    const appointmentId = req.params.id;
    const doctorId = req.session.user.user_id;

    const detailsQuery = `
        SELECT
            a.appointment_id,
            a.appointment_date,
            a.appointment_time,
            a.reason,
            '' AS consultation_type,
            a.status,
            u.name AS patientName,
            u.contact AS patientContact,
            u.email AS patientEmail,
            d.symptoms,
            d.diagnosis,
            d.prescription,
            d.doctor_note
        FROM appointments a
        JOIN users u ON u.user_id = a.patient_id
        LEFT JOIN diagnosis d ON d.appointment_id = a.appointment_id
        WHERE a.appointment_id = ? AND a.doctor_id = ?
    `;

    db.query(detailsQuery, [appointmentId, doctorId], (err, results) => {
        if (err) {
            console.error('Error fetching appointment details:', err);
            return res.status(500).send('Database error');
        }

        if (results.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/doctordashboard');
        }

        res.render('doctorAppointmentDetails', {
            appointment: results[0],
            backUrl: '/doctordashboard',
            backLabel: 'Back to Dashboard',
            showEditDiagnosis: true,
            message: req.flash('message')
        });
    });
});

// Show form to Add or Edit a Diagnosis
app.get('/adddiagnosis/:id', ensureRole('doctor'), (req, res) => {
    const appointmentId = req.params.id;
    const doctorId = req.session.user.user_id;

    const apptQuery = `
        SELECT
            a.appointment_id,
            a.appointment_date,
            a.appointment_time,
            a.reason,
            '' AS consultation_type,
            u.name AS patientName,
            d.symptoms,
            d.diagnosis,
            d.prescription,
            d.doctor_note
        FROM appointments a
        JOIN users u ON u.user_id = a.patient_id
        LEFT JOIN diagnosis d ON d.appointment_id = a.appointment_id
        WHERE a.appointment_id = ? AND a.doctor_id = ?
    `;

    db.query(apptQuery, [appointmentId, doctorId], (err, results) => {
        if (err) {
            console.error('Error fetching appointment:', err);
            return res.status(500).send('Database error');
        }

        if (results.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/doctordashboard');
        }

        res.render('adddiagnosis', {
            appointment: results[0],
            message: req.flash('message')
        });
    });
});

// Save a New or Edited Diagnosis to the Database
app.post('/adddiagnosis/:id', ensureRole('doctor'), (req, res) => {
    const appointmentId = req.params.id;
    const doctorId = req.session.user.user_id;
    const { symptoms, diagnosis, prescription, doctor_note } = req.body;

    if (!diagnosis) {
        req.flash('message', 'Diagnosis is required.');
        return res.redirect('/adddiagnosis/' + appointmentId);
    }

    // Double check that the doctor owns this appointment
    const ownerCheck = 'SELECT appointment_id FROM appointments WHERE appointment_id = ? AND doctor_id = ?';

    db.query(ownerCheck, [appointmentId, doctorId], (err, ownerResult) => {
        if (err) {
            console.error('Error verifying appointment:', err);
            return res.status(500).send('Database error');
        }

        if (ownerResult.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/doctordashboard');
        }

        const findQuery = 'SELECT diagnosis_id FROM diagnosis WHERE appointment_id = ?';

        // Choose INSERT (new) or UPDATE (edit) based on whether it exists
        db.query(findQuery, [appointmentId], (findErr, existing) => {
            if (findErr) {
                console.error('Error checking diagnosis record:', findErr);
                return res.status(500).send('Database error');
            }

            const saveQuery = existing.length > 0
                ? "UPDATE diagnosis SET symptoms = ?, diagnosis = ?, prescription = ?, doctor_note = ?, patient_request_status = 'not_requested' WHERE appointment_id = ?"
                : "INSERT INTO diagnosis (appointment_id, symptoms, diagnosis, prescription, doctor_note, patient_request_status) VALUES (?, ?, ?, ?, ?, 'not_requested')";

            const saveParams = existing.length > 0
                ? [symptoms || '', diagnosis, prescription || '', doctor_note || '', appointmentId]
                : [appointmentId, symptoms || '', diagnosis, prescription || '', doctor_note || ''];

            db.query(saveQuery, saveParams, (saveErr) => {
                if (saveErr) {
                    console.error('Error saving diagnosis:', saveErr);
                    req.flash('message', 'An error occurred while saving the diagnosis.');
                    return res.redirect('/adddiagnosis/' + appointmentId);
                }

                req.flash('message', 'Diagnosis saved successfully.');
                res.redirect('/doctordashboard');
            });
        });
    });
});

// Redirect old update URLs to the main adddiagnosis route
app.get('/updatediagnosis/:id', ensureRole('doctor'), (req, res) => {
    res.redirect('/adddiagnosis/' + req.params.id);
});
app.post('/updatediagnosis/:id', ensureRole('doctor'), (req, res) => {
    res.redirect(307, '/adddiagnosis/' + req.params.id);
});

// Mark an appointment as 'Completed'
app.post('/doctor/finish/:id', ensureRole('doctor'), (req, res) => {
    const appointmentId = req.params.id;
    const doctorId = req.session.user.user_id;

    const finishQuery = "UPDATE appointments SET status = 'Completed' WHERE appointment_id = ? AND doctor_id = ?";

    db.query(finishQuery, [appointmentId, doctorId], (err) => {
        if (err) {
            console.error('Error finishing appointment:', err);
            req.flash('message', 'An error occurred while finishing the appointment.');
            return res.redirect('/doctordashboard');
        }

        req.flash('message', 'Appointment marked as finished.');
        res.redirect('/doctordashboard');
    });
});

// ==============================================================================
// 7. ADMIN ROUTES
// ==============================================================================

// View and Edit Admin Profile
app.get('/admin/profile', ensureRole('admin'), (req, res) => {
    const userId = req.session.user.user_id;
    const sql = 'SELECT user_id, name, email, contact, password, role FROM users WHERE user_id = ? AND role = ?';

    db.query(sql, [userId, 'admin'], (err, rows) => {
        if (err) {
            console.error('Error loading admin profile:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'Admin profile not found.');
            return res.redirect('/admindashboard');
        }

        const admin = { ...rows[0], id: rows[0].user_id, phone: rows[0].contact };

        req.session.user = { ...req.session.user, ...admin, user_id: rows[0].user_id, id: rows[0].user_id, contact: rows[0].contact, phone: rows[0].contact };

        res.render('adminProfile', {
            admin,
            message: req.flash('message')
        });
    });
});

app.post('/admin/profile', ensureRole('admin'), (req, res) => {
    const userId = req.session.user.user_id;
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone) {
        req.flash('message', 'Please fill in all required fields.');
        return res.redirect('/admin/profile');
    }

    const hasNewPassword = !!(password && password.trim());
    const sql = hasNewPassword
        ? 'UPDATE users SET name = ?, email = ?, contact = ?, password = ? WHERE user_id = ? AND role = ?'
        : 'UPDATE users SET name = ?, email = ?, contact = ? WHERE user_id = ? AND role = ?';

    const params = hasNewPassword
        ? [name, email, phone, password.trim(), userId, 'admin']
        : [name, email, phone, userId, 'admin'];

    db.query(sql, params, (err) => {
        if (err) {
            console.error('Error updating admin profile:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'Email is already in use by another account.');
            } else {
                req.flash('message', 'Failed to update profile. Please try again.');
            }
            return res.redirect('/admin/profile');
        }

        req.session.user = { ...req.session.user, name, email, contact: phone, phone };

        req.flash('message', 'Profile updated successfully.');
        res.redirect('/admindashboard');
    });
});

// Admin Dashboard: Loads high-level statistics for the clinic
app.get('/admindashboard', ensureRole('admin'), (req, res) => {
    const statsSql = `
        SELECT
            (SELECT COUNT(*) FROM users WHERE role = 'patient') AS totalPatients,
            (SELECT COUNT(*) FROM users WHERE role = 'doctor') AS totalDoctors,
            (SELECT COUNT(*) FROM appointments WHERE appointment_date = CURDATE()) AS todaysAppointments,
            (SELECT COUNT(*) FROM diagnosis WHERE patient_request_status IN ('pending', 'approved', 'rejected')) AS diagnosisRequests,
            (SELECT COUNT(*) FROM diagnosis WHERE patient_request_status = 'pending') AS pendingRequests
    `;

    db.query(statsSql, (err, rows) => {
        if (err) {
            console.error('Error loading admin dashboard stats:', err);
            return res.status(500).send('Database error');
        }

        res.render('adminDashboard', {
            adminName: req.session.user.name,
            message: req.flash('message'),
            stats: rows[0] || {
                totalPatients: 0,
                totalDoctors: 0,
                todaysAppointments: 0,
                diagnosisRequests: 0,
                pendingRequests: 0
            }
        });
    });
});
app.get('/adminDashboard', (req, res) => res.redirect('/admindashboard'));

// View all Patients in the system
app.get('/admin/patients', ensureRole('admin'), (req, res) => {
    const sql = `
        SELECT user_id AS id, name, email, contact AS contactNumber
        FROM users WHERE role = 'patient' ORDER BY name ASC
    `;

    db.query(sql, (err, patients) => {
        if (err) {
            console.error('Error fetching patients:', err);
            return res.status(500).send('Database error');
        }

        res.render('admin_allpatientDetails', {
            adminName: req.session.user.name,
            patients,
            diagnosisRequests: [],
            searchName: '',
            message: req.flash('message')
        });
    });
});

// Search for a specific Patient
app.get('/admin/patients/search', ensureRole('admin'), (req, res) => {
    const name = (req.query.name || '').trim();

    const sql = `
        SELECT user_id AS id, name, email, contact AS contactNumber
        FROM users WHERE role = 'patient' AND name LIKE ? ORDER BY name ASC
    `;

    db.query(sql, [`%${name}%`], (err, patients) => {
        if (err) {
            console.error('Error searching patients:', err);
            return res.status(500).send('Database error');
        }

        const diagnosisSql = `
            SELECT
                p.name AS patientName,
                a.appointment_id AS appointmentId,
                a.appointment_date AS appointmentDate,
                a.reason,
                d.name AS doctorName,
                CASE
                    WHEN dg.patient_request_status = 'pending' THEN 'Pending'
                    WHEN dg.patient_request_status = 'approved' THEN 'Approved'
                    WHEN dg.patient_request_status = 'rejected' THEN 'Rejected'
                    ELSE 'Not Requested'
                END AS status
            FROM diagnosis dg
            JOIN appointments a ON a.appointment_id = dg.appointment_id
            JOIN users p ON p.user_id = a.patient_id
            LEFT JOIN users d ON d.user_id = a.doctor_id
            WHERE dg.patient_request_status IN ('pending', 'approved', 'rejected')
              AND (p.name LIKE ? OR d.name LIKE ?)
            ORDER BY a.appointment_date DESC, a.appointment_id DESC
        `;

        db.query(diagnosisSql, [`%${name}%`, `%${name}%`], (diagErr, diagnosisRequests) => {
            if (diagErr) {
                console.error('Error searching diagnosis requests:', diagErr);
                return res.status(500).send('Database error');
            }

            res.render('admin_allpatientDetails', {
                adminName: req.session.user.name,
                patients,
                diagnosisRequests,
                searchName: name,
                message: req.flash('message')
            });
        });
    });
});

// View all pending Medical Diagnosis Requests
app.get('/admin/diagnosis-requests', ensureRole('admin'), (req, res) => {
    const name = (req.query.name || '').trim();
    const sql = `
        SELECT
            p.name AS patientName,
            a.appointment_id AS appointmentId,
            a.appointment_date AS appointmentDate,
            a.reason,
            d.name AS doctorName,
            CASE
                WHEN dg.patient_request_status = 'pending' THEN 'Pending'
                WHEN dg.patient_request_status = 'approved' THEN 'Approved'
                WHEN dg.patient_request_status = 'rejected' THEN 'Rejected'
                ELSE 'Not Requested'
            END AS status
        FROM diagnosis dg
        JOIN appointments a ON a.appointment_id = dg.appointment_id
        JOIN users p ON p.user_id = a.patient_id
        LEFT JOIN users d ON d.user_id = a.doctor_id
        WHERE dg.patient_request_status = 'pending'
          AND (? = '' OR p.name LIKE ? OR d.name LIKE ?)
        ORDER BY a.appointment_date DESC, a.appointment_id DESC
    `;

    db.query(sql, [name, `%${name}%`, `%${name}%`], (err, requests) => {
        if (err) {
            console.error('Error loading diagnosis requests:', err);
            return res.status(500).send('Database error');
        }

        res.render('admin_diagnosisRequests', {
            adminName: req.session.user.name,
            requests,
            searchName: name,
            message: req.flash('message')
        });
    });
});

// Approve a Patient's request to view their diagnosis
app.post('/admin/diagnosis-requests/:id/approve', ensureRole('admin'), (req, res) => {
    const appointmentId = req.params.id;

    const updateSql = `
        UPDATE diagnosis
        SET patient_request_status = 'approved'
        WHERE appointment_id = ? AND patient_request_status = 'pending'
    `;

    db.query(updateSql, [appointmentId], (err, result) => {
        if (err) {
            console.error('Error approving diagnosis request:', err);
            req.flash('message', 'Failed to approve diagnosis request.');
            return res.redirect('/admin/diagnosis-requests');
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Diagnosis request is no longer pending.');
            return res.redirect('/admin/diagnosis-requests');
        }

        req.flash('message', 'Diagnosis request approved.');
        res.redirect('/admin/diagnosis-requests');
    });
});

// Reject a Patient's request to view their diagnosis
app.post('/admin/diagnosis-requests/:id/reject', ensureRole('admin'), (req, res) => {
    const appointmentId = req.params.id;

    const updateSql = `
        UPDATE diagnosis
        SET patient_request_status = 'rejected'
        WHERE appointment_id = ? AND patient_request_status = 'pending'
    `;

    db.query(updateSql, [appointmentId], (err, result) => {
        if (err) {
            console.error('Error rejecting diagnosis request:', err);
            req.flash('message', 'Failed to reject diagnosis request.');
            return res.redirect('/admin/diagnosis-requests');
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Diagnosis request is no longer pending.');
            return res.redirect('/admin/diagnosis-requests');
        }

        req.flash('message', 'Diagnosis request rejected.');
        res.redirect('/admin/diagnosis-requests');
    });
});

// View a specific Patient's History
app.get('/admin/patient/:id', ensureRole('admin'), (req, res) => {
    const patientId = req.params.id;

    const patientSql = `SELECT user_id AS id, name, email, contact AS contactNumber FROM users WHERE user_id = ? AND role = 'patient'`;

    db.query(patientSql, [patientId], (patientErr, patientResult) => {
        if (patientErr) {
            console.error('Error fetching patient:', patientErr);
            return res.status(500).send('Database error');
        }

        if (patientResult.length === 0) {
            req.flash('message', 'Patient not found.');
            return res.redirect('/admin/patients');
        }

        const appointmentSql = `
            SELECT
                a.appointment_id AS id,
                a.appointment_date AS date,
                a.appointment_time AS time,
                a.reason,
                a.status,
                d.name AS doctorName,
                dg.symptoms,
                dg.diagnosis,
                dg.prescription AS medication,
                dg.doctor_note AS note,
                CASE
                    WHEN dg.patient_request_status = 'pending' THEN 'Pending'
                    WHEN dg.patient_request_status = 'approved' THEN 'Approved'
                    WHEN dg.patient_request_status = 'rejected' THEN 'Rejected'
                    ELSE 'Not Requested'
                END AS diagnosisApprovalStatus,
                0 AS fee
            FROM appointments a
            LEFT JOIN users d ON a.doctor_id = d.user_id
            LEFT JOIN diagnosis dg ON dg.appointment_id = a.appointment_id
            WHERE a.patient_id = ?
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `;

        db.query(appointmentSql, [patientId], (apptErr, appointments) => {
            if (apptErr) {
                console.error('Error fetching patient appointments:', apptErr);
                return res.status(500).send('Database error');
            }

            res.render('admin_patientAppointment', {
                adminName: req.session.user.name,
                patient: patientResult[0],
                appointments,
                message: req.flash('message')
            });
        });
    });
});

// View all Doctors in the system
app.get('/admin/doctors', ensureRole('admin'), (req, res) => {
    const sql = `
        SELECT user_id AS id, name, email, contact AS contactNumber, '' AS specialization
        FROM users WHERE role = 'doctor' ORDER BY name ASC
    `;

    db.query(sql, (err, doctors) => {
        if (err) {
            console.error('Error fetching doctors:', err);
            return res.status(500).send('Database error');
        }

        res.render('admin_alldoctorDetails', {
            adminName: req.session.user.name,
            doctors,
            diagnosisRequests: [],
            searchName: '',
            message: req.flash('message')
        });
    });
});

// Search for a specific Doctor
app.get('/admin/doctors/search', ensureRole('admin'), (req, res) => {
    const name = (req.query.name || '').trim();

    const sql = `
        SELECT user_id AS id, name, email, contact AS contactNumber, '' AS specialization
        FROM users WHERE role = 'doctor' AND name LIKE ? ORDER BY name ASC
    `;

    db.query(sql, [`%${name}%`], (err, doctors) => {
        if (err) {
            console.error('Error searching doctors:', err);
            return res.status(500).send('Database error');
        }

        // Same diagnosis sub-query as patient search to preserve UI state
        const diagnosisSql = `
            SELECT
                p.name AS patientName,
                a.appointment_id AS appointmentId,
                a.appointment_date AS appointmentDate,
                a.reason,
                d.name AS doctorName,
                CASE
                    WHEN dg.patient_request_status = 'pending' THEN 'Pending'
                    WHEN dg.patient_request_status = 'approved' THEN 'Approved'
                    WHEN dg.patient_request_status = 'rejected' THEN 'Rejected'
                    ELSE 'Not Requested'
                END AS status
            FROM diagnosis dg
            JOIN appointments a ON a.appointment_id = dg.appointment_id
            JOIN users p ON p.user_id = a.patient_id
            LEFT JOIN users d ON d.user_id = a.doctor_id
            WHERE dg.patient_request_status IN ('pending', 'approved', 'rejected')
              AND (p.name LIKE ? OR d.name LIKE ?)
            ORDER BY a.appointment_date DESC, a.appointment_id DESC
        `;

        db.query(diagnosisSql, [`%${name}%`, `%${name}%`], (diagErr, diagnosisRequests) => {
            if (diagErr) {
                console.error('Error searching diagnosis requests:', diagErr);
                return res.status(500).send('Database error');
            }

            res.render('admin_alldoctorDetails', {
                adminName: req.session.user.name,
                doctors,
                diagnosisRequests,
                searchName: name,
                message: req.flash('message')
            });
        });
    });
});

// View a specific Doctor's Patient Records
app.get('/admin/doctor/:id', ensureRole('admin'), (req, res) => {
    const doctorId = req.params.id;

    const doctorSql = `SELECT user_id AS id, name, email, contact AS contactNumber FROM users WHERE user_id = ? AND role = 'doctor'`;

    db.query(doctorSql, [doctorId], (doctorErr, doctorResult) => {
        if (doctorErr) {
            console.error('Error fetching doctor:', doctorErr);
            return res.status(500).send('Database error');
        }

        if (doctorResult.length === 0) {
            req.flash('message', 'Doctor not found.');
            return res.redirect('/admin/doctors');
        }

        const recordSql = `
            SELECT
                a.appointment_id AS id,
                p.name AS patientName,
                '' AS clinicName,
                a.appointment_date AS date,
                a.appointment_time AS time,
                a.reason,
                a.status,
                dg.symptoms,
                dg.diagnosis,
                dg.prescription AS medication,
                dg.doctor_note AS note,
                CASE WHEN dg.diagnosis_id IS NULL THEN 'No' ELSE 'Yes' END AS diagnosisCompleted,
                0 AS fee
            FROM appointments a
            JOIN users p ON p.user_id = a.patient_id
            LEFT JOIN diagnosis dg ON dg.appointment_id = a.appointment_id
            WHERE a.doctor_id = ?
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `;

        db.query(recordSql, [doctorId], (recordErr, records) => {
            if (recordErr) {
                console.error('Error fetching doctor records:', recordErr);
                return res.status(500).send('Database error');
            }

            res.render('admin_doctorRecord', {
                adminName: req.session.user.name,
                doctor: doctorResult[0],
                records,
                message: req.flash('message')
            });
        });
    });
});

// Delete a Patient (and all their linked records)
app.get('/admin/patient/delete/:id', ensureRole('admin'), (req, res) => {
    const patientId = req.params.id;

    const deleteDiagnosisSql = `
        DELETE d FROM diagnosis d
        INNER JOIN appointments a ON a.appointment_id = d.appointment_id
        WHERE a.patient_id = ?
    `;

    db.query(deleteDiagnosisSql, [patientId], (diagErr) => {
        if (diagErr) {
            console.error('Error deleting patient diagnosis:', diagErr);
            req.flash('message', 'Failed to delete patient records.');
            return res.redirect('/admin/patients');
        }

        db.query('DELETE FROM appointments WHERE patient_id = ?', [patientId], (apptErr) => {
            if (apptErr) {
                console.error('Error deleting patient appointments:', apptErr);
                req.flash('message', 'Failed to delete patient appointments.');
                return res.redirect('/admin/patients');
            }

            db.query("DELETE FROM users WHERE user_id = ? AND role = 'patient'", [patientId], (userErr) => {
                if (userErr) {
                    console.error('Error deleting patient user:', userErr);
                    req.flash('message', 'Failed to delete patient user.');
                    return res.redirect('/admin/patients');
                }

                req.flash('message', 'Patient deleted successfully.');
                res.redirect('/admin/patients');
            });
        });
    });
});

// Delete a Doctor (and all their linked records)
app.get('/admin/doctor/delete/:id', ensureRole('admin'), (req, res) => {
    const doctorId = req.params.id;

    const deleteDiagnosisSql = `
        DELETE d FROM diagnosis d
        INNER JOIN appointments a ON a.appointment_id = d.appointment_id
        WHERE a.doctor_id = ?
    `;

    db.query(deleteDiagnosisSql, [doctorId], (diagErr) => {
        if (diagErr) {
            console.error('Error deleting doctor diagnosis:', diagErr);
            req.flash('message', 'Failed to delete doctor records.');
            return res.redirect('/admin/doctors');
        }

        db.query('DELETE FROM appointments WHERE doctor_id = ?', [doctorId], (apptErr) => {
            if (apptErr) {
                console.error('Error deleting doctor appointments:', apptErr);
                req.flash('message', 'Failed to delete doctor appointments.');
                return res.redirect('/admin/doctors');
            }

            db.query("DELETE FROM users WHERE user_id = ? AND role = 'doctor'", [doctorId], (userErr) => {
                if (userErr) {
                    console.error('Error deleting doctor user:', userErr);
                    req.flash('message', 'Failed to delete doctor user.');
                    return res.redirect('/admin/doctors');
                }

                req.flash('message', 'Doctor deleted successfully.');
                res.redirect('/admin/doctors');
            });
        });
    });
});

// Admin: Edit Patient details
app.get('/admin/patient/edit/:id', ensureRole('admin'), (req, res) => {
    const patientId = req.params.id;
    const sql = `SELECT user_id AS id, name, email, contact AS contactNumber FROM users WHERE user_id = ? AND role = 'patient'`;

    db.query(sql, [patientId], (err, rows) => {
        if (err) {
            console.error('Error loading patient edit form:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'Patient not found.');
            return res.redirect('/admin/patients');
        }

        res.render('admin_editPatient', {
            adminName: req.session.user.name,
            patient: rows[0],
            message: req.flash('message')
        });
    });
});

app.post('/admin/patient/edit/:id', ensureRole('admin'), (req, res) => {
    const patientId = req.params.id;
    const { name, email, contactNumber, password } = req.body;

    if (!name || !email || !contactNumber) {
        req.flash('message', 'Name, email and contact number are required.');
        return res.redirect('/admin/patient/edit/' + patientId);
    }

    const trimmedPassword = (password || '').trim();
    const hasNewPassword = !!trimmedPassword;
    const sql = hasNewPassword
        ? `UPDATE users SET name = ?, email = ?, contact = ?, password = ? WHERE user_id = ? AND role = 'patient'`
        : `UPDATE users SET name = ?, email = ?, contact = ? WHERE user_id = ? AND role = 'patient'`;

    const params = hasNewPassword
        ? [name.trim(), email.trim(), contactNumber.trim(), trimmedPassword, patientId]
        : [name.trim(), email.trim(), contactNumber.trim(), patientId];

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Error updating patient:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'Email is already in use by another account.');
            } else {
                req.flash('message', 'Failed to update patient profile.');
            }
            return res.redirect('/admin/patient/edit/' + patientId);
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Patient not found.');
            return res.redirect('/admin/patients');
        }

        req.flash('message', 'Patient profile updated successfully.');
        res.redirect('/admin/patient/' + patientId);
    });
});

// Admin: Reset a Patient's Password
app.post('/admin/patient/reset-password/:id', ensureRole('admin'), (req, res) => {
    const patientId = req.params.id;
    const newPassword = (req.body.newPassword || '').trim();

    if (!newPassword) {
        req.flash('message', 'Please enter a new password.');
        return res.redirect('/admin/patient/' + patientId);
    }

    const sql = "UPDATE users SET password = ? WHERE user_id = ? AND role = 'patient'";

    db.query(sql, [newPassword, patientId], (err, result) => {
        if (err) {
            console.error('Error resetting patient password:', err);
            req.flash('message', 'Failed to reset patient password.');
            return res.redirect('/admin/patient/' + patientId);
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Patient not found.');
            return res.redirect('/admin/patients');
        }

        req.flash('message', 'Patient password reset successfully.');
        res.redirect('/admin/patient/' + patientId);
    });
});

// Admin: Edit Doctor details
app.get('/admin/doctor/edit/:id', ensureRole('admin'), (req, res) => {
    const doctorId = req.params.id;
    const sql = `SELECT user_id AS id, name, email, contact AS contactNumber FROM users WHERE user_id = ? AND role = 'doctor'`;

    db.query(sql, [doctorId], (err, rows) => {
        if (err) {
            console.error('Error loading doctor edit form:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'Doctor not found.');
            return res.redirect('/admin/doctors');
        }

        res.render('admin_editDoctor', {
            adminName: req.session.user.name,
            doctor: rows[0],
            message: req.flash('message')
        });
    });
});

app.post('/admin/doctor/edit/:id', ensureRole('admin'), (req, res) => {
    const doctorId = req.params.id;
    const { name, email, contactNumber, password } = req.body;

    if (!name || !email || !contactNumber) {
        req.flash('message', 'Name, email and contact number are required.');
        return res.redirect('/admin/doctor/edit/' + doctorId);
    }

    const trimmedPassword = (password || '').trim();
    const hasNewPassword = !!trimmedPassword;
    const sql = hasNewPassword
        ? `UPDATE users SET name = ?, email = ?, contact = ?, password = ? WHERE user_id = ? AND role = 'doctor'`
        : `UPDATE users SET name = ?, email = ?, contact = ? WHERE user_id = ? AND role = 'doctor'`;

    const params = hasNewPassword
        ? [name.trim(), email.trim(), contactNumber.trim(), trimmedPassword, doctorId]
        : [name.trim(), email.trim(), contactNumber.trim(), doctorId];

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Error updating doctor:', err);
            if (err.code === 'ER_DUP_ENTRY') {
                req.flash('message', 'Email is already in use by another account.');
            } else {
                req.flash('message', 'Failed to update doctor profile.');
            }
            return res.redirect('/admin/doctor/edit/' + doctorId);
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Doctor not found.');
            return res.redirect('/admin/doctors');
        }

        req.flash('message', 'Doctor profile updated successfully.');
        res.redirect('/admin/doctor/' + doctorId);
    });
});

// Admin: Reset a Doctor's password
app.post('/admin/doctor/reset-password/:id', ensureRole('admin'), (req, res) => {
    const doctorId = req.params.id;
    const newPassword = (req.body.newPassword || '').trim();

    if (!newPassword) {
        req.flash('message', 'Please enter a new password.');
        return res.redirect('/admin/doctor/' + doctorId);
    }

    const sql = "UPDATE users SET password = ? WHERE user_id = ? AND role = 'doctor'";

    db.query(sql, [newPassword, doctorId], (err, result) => {
        if (err) {
            console.error('Error resetting doctor password:', err);
            req.flash('message', 'Failed to reset doctor password.');
            return res.redirect('/admin/doctor/' + doctorId);
        }

        if (result.affectedRows === 0) {
            req.flash('message', 'Doctor not found.');
            return res.redirect('/admin/doctors');
        }

        req.flash('message', 'Doctor password reset successfully.');
        res.redirect('/admin/doctor/' + doctorId);
    });
});

// Admin: View detailed appointment information
app.get('/admin/appointment/:id', ensureRole('admin'), (req, res) => {
    const appointmentId = req.params.id;
    const backUrl = req.query.backUrl || '/admindashboard';
    const backLabel = req.query.backLabel || 'Back to Dashboard';

    const sql = `
        SELECT
            a.appointment_id,
            a.appointment_date,
            a.appointment_time,
            a.reason,
            '' AS consultation_type,
            a.status,
            p.name AS patientName,
            p.contact AS patientContact,
            p.email AS patientEmail,
            d.symptoms,
            d.diagnosis,
            d.prescription,
            d.doctor_note
        FROM appointments a
        JOIN users p ON p.user_id = a.patient_id
        LEFT JOIN diagnosis d ON d.appointment_id = a.appointment_id
        WHERE a.appointment_id = ?
    `;

    db.query(sql, [appointmentId], (err, rows) => {
        if (err) {
            console.error('Error loading admin appointment view:', err);
            return res.status(500).send('Database error');
        }

        if (rows.length === 0) {
            req.flash('message', 'Appointment not found.');
            return res.redirect('/admindashboard');
        }

        res.render('doctorAppointmentDetails', {
            appointment: rows[0],
            backUrl,
            backLabel,
            showEditDiagnosis: false,
            message: req.flash('message')
        });
    });
});

app.get('/admin/record/:id', ensureRole('admin'), (req, res) => {
    const query = new URLSearchParams();
    if (req.query.backUrl) query.set('backUrl', req.query.backUrl);
    if (req.query.backLabel) query.set('backLabel', req.query.backLabel);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    res.redirect('/admin/appointment/' + req.params.id + suffix);
});

// Admin: API endpoint to fetch all appointments (used for tables/charts)
app.get('/admin/appointments', ensureRole('admin'), (req, res) => {
    const sql = `
        SELECT
            a.appointment_id,
            a.appointment_date,
            a.appointment_time,
            a.reason,
            a.status,
            doctor.name AS doctorName,
            patient.name AS patientName
        FROM appointments a
        LEFT JOIN users doctor ON doctor.user_id = a.doctor_id
        LEFT JOIN users patient ON patient.user_id = a.patient_id
        ORDER BY a.appointment_date DESC, a.appointment_time DESC
    `;

    db.query(sql, (err, appointments) => {
        if (err) {
            console.error('Error fetching all appointments:', err);
            return res.status(500).send('Database error');
        }

        res.json({ appointments });
    });
});

// ==============================================================================
// 8. SERVER START
// ==============================================================================

// Start the Node.js server on port 3000
app.listen(3000, () => {
    console.log('Server started on port http://localhost:3000');
});