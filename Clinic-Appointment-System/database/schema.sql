-- ==========================
-- USERS TABLE
-- ==========================
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    contact VARCHAR(20) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('doctor', 'patient', 'admin') NOT NULL
);

-- ==========================
-- APPOINTMENTS TABLE
-- ==========================
CREATE TABLE appointments (
    appointment_id INT AUTO_INCREMENT PRIMARY KEY,
    doctor_id INT NOT NULL,
    patient_id INT NOT NULL,
    appointment_date DATE NOT NULL,
    appointment_time TIME NOT NULL,
    reason TEXT,
    status ENUM('Pending', 'Approved', 'Completed', 'Cancelled') DEFAULT 'Pending',

    FOREIGN KEY (doctor_id) REFERENCES users(user_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (patient_id) REFERENCES users(user_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- ==========================
-- DIAGNOSIS TABLE
-- ==========================
CREATE TABLE diagnosis (
    diagnosis_id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NOT NULL,
    symptoms TEXT NOT NULL,
    diagnosis TEXT NOT NULL,
    prescription TEXT,
    doctor_note TEXT,

    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);