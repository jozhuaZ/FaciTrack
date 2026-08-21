-- Migration: Consultation Room Setup
-- Description: Creates tables and updates for consultation room management

-- ======================================
-- 1. Program Tables
-- ======================================
CREATE TABLE IF NOT EXISTS `consultation_program_tables` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `program_code` VARCHAR(10) NOT NULL UNIQUE,
  `program_name` VARCHAR(100) NOT NULL,
  `table_capacity` INT NOT NULL DEFAULT 4 COMMENT 'Max face-to-face tables available per room',
  `status` ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_program_code` (`program_code`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default program tables
INSERT INTO `consultation_program_tables` (`program_code`, `program_name`, `table_capacity`, `status`) VALUES
('BSIT', 'Bachelor of Science in Information Technology', 4, 'Active'),
('BLIS', 'Bachelor of Library and Information Science', 4, 'Active'),
('BSCS', 'Bachelor of Science in Computer Science', 4, 'Active'),
('BSIS', 'Bachelor of Science in Information Systems', 4, 'Active')
ON DUPLICATE KEY UPDATE 
  `program_name` = VALUES(`program_name`),
  `table_capacity` = VALUES(`table_capacity`);

-- ======================================
-- 2. Update Departments Table
-- ======================================
ALTER TABLE `departments` 
ADD COLUMN IF NOT EXISTS `program_code` VARCHAR(10) NULL AFTER `full_name`,
ADD INDEX IF NOT EXISTS `idx_program_code` (`program_code`);

-- Link departments to programs
UPDATE `departments` SET `program_code` = 'BSIT' WHERE `full_name` LIKE '%Information Technology%' OR `short_name` = 'BSIT';
UPDATE `departments` SET `program_code` = 'BLIS' WHERE `full_name` LIKE '%Library%' OR `short_name` = 'BLIS';
UPDATE `departments` SET `program_code` = 'BSCS' WHERE `full_name` LIKE '%Computer Science%' OR `short_name` = 'BSCS';
UPDATE `departments` SET `program_code` = 'BSIS' WHERE `full_name` LIKE '%Information Systems%' OR `short_name` = 'BSIS';

-- ======================================
-- 3. Update Rooms Table
-- ======================================
-- Add capacity column to rooms table if not exists
ALTER TABLE `rooms`
ADD COLUMN IF NOT EXISTS `capacity` INT NOT NULL DEFAULT 5 AFTER `room_type`,
ADD INDEX IF NOT EXISTS `idx_room_type_status` (`room_type`, `status`);

-- Set capacity for existing consultation rooms
UPDATE `rooms` SET `capacity` = 4 WHERE `room_type` = 'Consultation Room' AND `capacity` = 5;

-- ======================================
-- 4. Update Slot Reservations Table
-- ======================================
-- Modify reservation time from 5 minutes to 2 minutes
-- This is handled in the application logic (SlotReservationModel.js)
-- RESERVATION_MS = 2 * 60 * 1000; (2 minutes)

-- Add index for better query performance
ALTER TABLE `slot_reservations`
ADD INDEX IF NOT EXISTS `idx_expires_at` (`expires_at`);

-- ======================================
-- 5. Update Appointments Table
-- ======================================
-- Add Google Meet link column for online consultations
ALTER TABLE `appointments`
ADD COLUMN IF NOT EXISTS `meet_link` VARCHAR(255) NULL AFTER `notes`,
ADD COLUMN IF NOT EXISTS `meet_code` VARCHAR(50) NULL AFTER `meet_link`,
ADD INDEX IF NOT EXISTS `idx_mode_status` (`mode`, `status`);

-- ======================================
-- 6. Consultation Logs View
-- ======================================
-- Create a view for easier consultation logs querying
CREATE OR REPLACE VIEW `consultation_logs_view` AS
SELECT 
    a.id AS appointment_id,
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
    u.id AS instructor_id,
    u.first_name AS instructor_first_name,
    u.last_name AS instructor_last_name,
    u.position AS instructor_position,
    s.id AS student_id,
    s.first_name AS student_first_name,
    s.last_name AS student_last_name,
    s.public_id AS student_public_id,
    r.id AS room_id,
    r.room_number,
    d.id AS department_id,
    d.full_name AS department_name,
    d.program_code
FROM appointments a
INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
INNER JOIN users u ON a.instructor_id = u.id
INNER JOIN users s ON a.student_id = s.id
INNER JOIN departments d ON u.department_id = d.id
LEFT JOIN rooms r ON a.room_id = r.id;

-- ======================================
-- 7. Room Availability Function
-- ======================================
-- Stored procedure to check room availability
DELIMITER $$

CREATE PROCEDURE IF NOT EXISTS `check_room_availability`(
    IN p_program_code VARCHAR(10),
    IN p_consultation_date DATE,
    IN p_start_time TIME,
    IN p_end_time TIME
)
BEGIN
    SELECT 
        r.id,
        r.room_number,
        r.capacity,
        r.room_type,
        r.status,
        d.full_name AS department_name,
        (SELECT COUNT(*) 
         FROM appointments a
         INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         WHERE a.room_id = r.id
           AND a.status IN ('pending', 'confirmed')
           AND a.mode = 'Face-to-Face'
           AND ch.consultation_date = p_consultation_date
           AND ch.start_time < p_end_time
           AND ch.end_time > p_start_time
        ) AS current_bookings,
        (r.capacity - (SELECT COUNT(*) 
         FROM appointments a
         INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         WHERE a.room_id = r.id
           AND a.status IN ('pending', 'confirmed')
           AND a.mode = 'Face-to-Face'
           AND ch.consultation_date = p_consultation_date
           AND ch.start_time < p_end_time
           AND ch.end_time > p_start_time
        )) AS available_slots
    FROM rooms r
    INNER JOIN departments d ON r.department_id = d.id
    WHERE d.program_code = p_program_code
      AND r.room_type = 'Consultation Room'
      AND r.status = 'Active'
    HAVING available_slots > 0
    ORDER BY current_bookings ASC, r.room_number;
END$$

DELIMITER ;

-- ======================================
-- 8. Cleanup Expired Reservations
-- ======================================
-- Event to automatically clean up expired slot reservations
-- This ensures slots become available immediately after 2-minute timer expires

DELIMITER $$

CREATE EVENT IF NOT EXISTS `cleanup_expired_reservations`
ON SCHEDULE EVERY 1 MINUTE
DO
BEGIN
    -- Delete expired reservations
    DELETE FROM slot_reservations WHERE expires_at < NOW();
    
    -- Update consultation hours status for freed slots
    UPDATE consultation_hours ch
    SET ch.status = 'Available'
    WHERE ch.status != 'closed'
      AND NOT EXISTS (
          SELECT 1 FROM appointments a 
          WHERE a.consultation_hour_id = ch.id 
            AND a.status IN ('pending', 'confirmed')
      )
      AND NOT EXISTS (
          SELECT 1 FROM slot_reservations sr 
          WHERE sr.slot_id = ch.id 
            AND sr.expires_at > NOW()
      );
END$$

DELIMITER ;

-- Enable event scheduler if not already enabled
SET GLOBAL event_scheduler = ON;

-- ======================================
-- 9. Reset Past Slots Event
-- ======================================
-- Event to reset slots after their date/time has passed

DELIMITER $$

CREATE EVENT IF NOT EXISTS `reset_past_consultation_slots`
ON SCHEDULE EVERY 1 HOUR
DO
BEGIN
    -- Reset slots that have passed and have no active appointments
    UPDATE consultation_hours ch
    SET ch.status = 'Available'
    WHERE CONCAT(ch.consultation_date, ' ', ch.end_time) < NOW()
      AND ch.status != 'closed'
      AND NOT EXISTS (
          SELECT 1 FROM appointments a 
          WHERE a.consultation_hour_id = ch.id 
            AND a.status IN ('pending', 'confirmed')
      );
END$$

DELIMITER ;

-- ======================================
-- 10. Statistics Indexes
-- ======================================
-- Add indexes for better performance on statistics queries

ALTER TABLE `appointments`
ADD INDEX IF NOT EXISTS `idx_created_at` (`created_at`),
ADD INDEX IF NOT EXISTS `idx_status_mode` (`status`, `mode`);

ALTER TABLE `consultation_hours`
ADD INDEX IF NOT EXISTS `idx_consultation_date` (`consultation_date`),
ADD INDEX IF NOT EXISTS `idx_instructor_date` (`instructor_id`, `consultation_date`);

-- ======================================
-- Migration Complete
-- ======================================

SELECT 'Consultation Room Migration Completed Successfully!' AS Status;
