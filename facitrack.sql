CREATE DATABASE IF NOT EXISTS facitrack
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE facitrack;

-- -----------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------

CREATE TABLE departments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  full_name    VARCHAR(150) NOT NULL,
  program_code VARCHAR(10)  NULL,
  short_name   VARCHAR(20)  NULL,
  building     VARCHAR(100) NULL,
  INDEX idx_program_code (program_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  public_id       VARCHAR(36)  NOT NULL UNIQUE DEFAULT (UUID()),
  first_name      VARCHAR(100) NOT NULL,
  middle_name     VARCHAR(100) NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  hashed_password VARCHAR(255) NULL,
  role            ENUM('Admin','SuperAdmin','Dean','Instructor','Student') NOT NULL,
  employment_type VARCHAR(50)  NULL,
  position        VARCHAR(100) NULL,
  status          ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  profile_picture VARCHAR(255) NULL,
  department_id   INT          NULL,
  last_login      DATETIME     NULL,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  INDEX idx_role   (role),
  INDEX idx_email  (email),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rooms (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  room_number              VARCHAR(50)  NOT NULL,
  department_id            INT          NULL,
  room_type                VARCHAR(50)  NOT NULL,
  capacity                 INT          NOT NULL DEFAULT 5,
  assigned_faculty         INT          NULL,
  is_ble_scanner_installed TINYINT      NOT NULL DEFAULT 0,
  status                   ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at               TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id)    REFERENCES departments(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_faculty) REFERENCES users(id)       ON DELETE SET NULL,
  INDEX idx_room_type_status (room_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultation_hours (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  instructor_id     INT          NOT NULL,
  day_of_the_week   VARCHAR(10)  NOT NULL,
  consultation_date DATE         NOT NULL,
  start_time        TIME         NOT NULL,
  end_time          TIME         NOT NULL,
  status            ENUM('Available','Booked','closed') NOT NULL DEFAULT 'Available',
  is_booked         TINYINT      NOT NULL DEFAULT 0,
  recurrence_id     VARCHAR(36)  NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_consultation_date (consultation_date),
  INDEX idx_instructor_date   (instructor_id, consultation_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE slot_reservations (
  id         INT      AUTO_INCREMENT PRIMARY KEY,
  slot_id    INT      NOT NULL UNIQUE,
  student_id INT      NOT NULL,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (slot_id)    REFERENCES consultation_hours(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id)              ON DELETE CASCADE,
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE appointments (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  consultation_hour_id INT          NOT NULL,
  student_id           INT          NOT NULL,
  instructor_id        INT          NOT NULL,
  student_number       VARCHAR(50)  NULL,
  section_group_name   VARCHAR(100) NULL,
  course_subject       VARCHAR(150) NULL,
  email                VARCHAR(255) NULL,
  topic                TEXT         NULL,
  mode                 ENUM('Synchronous','Online') NOT NULL,
  notes                TEXT         NULL,
  meet_link            VARCHAR(255) NULL,
  meet_code            VARCHAR(50)  NULL,
  status               ENUM('pending','confirmed','rescheduled','declined','completed','cancelled') NOT NULL DEFAULT 'pending',
  decline_reason       TEXT         NULL,
  room_id              INT          NULL,
  rescheduled_to_id    INT          NULL,
  rescheduled_from_id  INT          NULL,
  created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (consultation_hour_id) REFERENCES consultation_hours(id),
  FOREIGN KEY (student_id)           REFERENCES users(id),
  FOREIGN KEY (instructor_id)        REFERENCES users(id),
  FOREIGN KEY (room_id)              REFERENCES rooms(id)        ON DELETE SET NULL,
  FOREIGN KEY (rescheduled_to_id)    REFERENCES appointments(id) ON DELETE SET NULL,
  FOREIGN KEY (rescheduled_from_id)  REFERENCES appointments(id) ON DELETE SET NULL,
  INDEX idx_mode_status (mode, status),
  INDEX idx_status_mode (status, mode),
  INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE instructor_unavailability (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  instructor_id INT  NOT NULL,
  unavail_date  DATE NOT NULL,
  reason        TEXT NULL,
  UNIQUE KEY uq_instructor_date (instructor_id, unavail_date),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workload_subjects (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  instructor_id INT          NOT NULL,
  subject_code  VARCHAR(50)  NOT NULL,
  subject_name  VARCHAR(150) NOT NULL,
  color_hex     VARCHAR(7)   NULL,
  units         DECIMAL(4,1) NULL,
  UNIQUE KEY uq_instructor_code (instructor_id, subject_code),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workload_blocks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  instructor_id INT          NOT NULL,
  subject_id    INT          NOT NULL,
  day_of_week   VARCHAR(10)  NOT NULL,
  start_slot    INT          NOT NULL,
  end_slot      INT          NOT NULL,
  room_id       INT          NULL,
  section_name  VARCHAR(100) NULL,
  class_type    VARCHAR(50)  NOT NULL DEFAULT 'Lecture',
  color_hex     VARCHAR(7)   NULL,
  UNIQUE KEY uq_instructor_day_slot (instructor_id, day_of_week, start_slot),
  FOREIGN KEY (instructor_id) REFERENCES users(id)             ON DELETE CASCADE,
  FOREIGN KEY (subject_id)    REFERENCES workload_subjects(id)  ON DELETE CASCADE,
  FOREIGN KEY (room_id)       REFERENCES rooms(id)              ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultation_program_tables (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  program_code   VARCHAR(10)  NOT NULL UNIQUE,
  program_name   VARCHAR(100) NOT NULL,
  table_capacity INT          NOT NULL DEFAULT 4,
  status         ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_program_code (program_code),
  INDEX idx_status       (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultation_settings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  setting_key   VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT         NOT NULL,
  description   VARCHAR(255) NULL,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by    INT          NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_setting_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------
-- Seed Data
-- -----------------------------------------------------------------

INSERT INTO consultation_program_tables (program_code, program_name, table_capacity, status) VALUES
('BSIT', 'Bachelor of Science in Information Technology', 4, 'Active'),
('BLIS', 'Bachelor of Library and Information Science',   4, 'Active'),
('BSCS', 'Bachelor of Science in Computer Science',       4, 'Active'),
('BSIS', 'Bachelor of Science in Information Systems',    4, 'Active')
AS new_vals
ON DUPLICATE KEY UPDATE
  program_name   = new_vals.program_name,
  table_capacity = new_vals.table_capacity;

INSERT INTO consultation_settings (setting_key, setting_value, description) VALUES
('daily_sync_limit', '10', 'Maximum number of synchronous (in-person) consultations allowed per day across all programs');

INSERT INTO departments (full_name, program_code, short_name, building) VALUES
('Information Technology',          'BSIT', 'BSIT', 'Building A'),
('Library and Information Science', 'BLIS', 'BLIS', 'Building B'),
('Computer Science',                'BSCS', 'BSCS', 'Building A'),
('Information Systems',             'BSIS', 'BSIS', 'Building C');

-- -----------------------------------------------------------------
-- Seed Users
--   admin123      -> Admin / SuperAdmin
--   dean123       -> Dean
--   instructor123 -> Instructors
--   student123    -> Student
-- -----------------------------------------------------------------

INSERT INTO users
  (first_name, middle_name, last_name, email, hashed_password, role, employment_type, position, status, department_id)
VALUES
  -- Admin
  ('Ja',      NULL,     'Quintana',  'jaquintana@cspc.edu.ph',
   '$2b$10$63apl5oPXkf/bLfgpE0rFucYOZJMV8ULfKX5s2FzfqWZGf4hF7yWW',
   'Admin', NULL, 'System Administrator', 'Active', NULL),

  -- SuperAdmin
  ('Super',   NULL,     'Admin',     'superadmin@cspc.edu.ph',
   '$2b$10$pfYD47UxL7BSJvK.t3p1XOKK4Uherf0nWr.AKMvN6FhEnpNc.2LY2',
   'SuperAdmin', NULL, 'Super Administrator', 'Active', NULL),

  -- Dean
  ('Lourdes', NULL,     'Reyes',     'dean@cspc.edu.ph',
   '$2b$10$59SzKvw0oPLAANM6vDAUpus5jHtf5yotv4kmguuGRFfyTtsLaTdee',
   'Dean', 'Full-time', 'Dean', 'Active', 1),

  -- Instructor 1 — BSIT
  ('Maria',   'Santos', 'Cruz',      'mcruz@cspc.edu.ph',
   '$2b$10$yFkbHKS.Kx8pzgr9CnAm9up7Ne6pxjrRGgeCmpva3ezSCX7MYsAPa',
   'Instructor', 'Full-time', 'Instructor I', 'Active', 1),

  -- Instructor 2 — BSCS
  ('Jose',    'Maria',  'Santos',    'jmsantos@cspc.edu.ph',
   '$2b$10$yFkbHKS.Kx8pzgr9CnAm9up7Ne6pxjrRGgeCmpva3ezSCX7MYsAPa',
   'Instructor', 'Part-time', 'Instructor II', 'Active', 3),

  -- Student
  ('Juan',    NULL,     'Dela Cruz', 'jdelacruz@my.cspc.edu.ph',
   '$2b$10$W.QAuD09V/SZLaaWDh7VEOT8PIvdWdQ82RM9yzqpDBi3M3w7CfFhO',
   'Student', NULL, NULL, 'Active', 1);

-- -----------------------------------------------------------------
-- View
-- -----------------------------------------------------------------

CREATE OR REPLACE VIEW consultation_logs_view AS
SELECT
    a.id                 AS appointment_id,
    a.status,
    a.mode,
    a.topic,
    a.course_subject,
    a.section_group_name,
    a.created_at,
    a.meet_link,
    a.meet_code,
    ch.consultation_date,
    ch.start_time,
    ch.end_time,
    u.id                 AS instructor_id,
    u.first_name         AS instructor_first_name,
    u.last_name          AS instructor_last_name,
    u.position           AS instructor_position,
    s.id                 AS student_id,
    s.first_name         AS student_first_name,
    s.last_name          AS student_last_name,
    s.public_id          AS student_public_id,
    r.id                 AS room_id,
    r.room_number,
    d.id                 AS department_id,
    d.full_name          AS department_name,
    d.program_code
FROM appointments a
INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
INNER JOIN users u               ON a.instructor_id        = u.id
INNER JOIN users s               ON a.student_id           = s.id
INNER JOIN departments d         ON u.department_id        = d.id
LEFT  JOIN rooms r               ON a.room_id              = r.id;

-- -----------------------------------------------------------------
-- Events (auto-cleanup)
-- -----------------------------------------------------------------

SET GLOBAL event_scheduler = ON;

DELIMITER $$

CREATE EVENT IF NOT EXISTS cleanup_expired_reservations
ON SCHEDULE EVERY 1 MINUTE
DO BEGIN
    DELETE FROM slot_reservations WHERE expires_at < NOW();
    UPDATE consultation_hours ch
    SET ch.status = 'Available'
    WHERE ch.status != 'closed'
      AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.consultation_hour_id = ch.id
            AND a.status IN ('pending','confirmed')
      )
      AND NOT EXISTS (
          SELECT 1 FROM slot_reservations sr
          WHERE sr.slot_id = ch.id AND sr.expires_at > NOW()
      );
END$$

CREATE EVENT IF NOT EXISTS reset_past_consultation_slots
ON SCHEDULE EVERY 1 HOUR
DO BEGIN
    UPDATE consultation_hours ch
    SET ch.status = 'Available'
    WHERE CONCAT(ch.consultation_date, ' ', ch.end_time) < NOW()
      AND ch.status != 'closed'
      AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.consultation_hour_id = ch.id
            AND a.status IN ('pending','confirmed')
      );
END$$

DELIMITER ;
