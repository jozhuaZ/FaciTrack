-- ============================================================
-- FaciTrack — Canonical Database Schema
-- Target: MariaDB 10.4+ / MySQL 8+
--
-- Import order matters: departments and rooms are created before
-- users, then the two back-references (departments.dean_id and
-- rooms.assigned_faculty) are attached with ALTER TABLE once
-- users exists. Seed rows live in facitrack_db_seed.sql.
-- ============================================================

CREATE DATABASE IF NOT EXISTS facitrack;
USE facitrack;

-- ------------------------------------------------------------
-- Organizational structure
-- ------------------------------------------------------------

CREATE TABLE departments (
    id          TINYINT UNSIGNED AUTO_INCREMENT,
    full_name   VARCHAR(100) NOT NULL,
    short_name  VARCHAR(10)  NOT NULL,
    building    VARCHAR(100) NOT NULL,
    dean_id     BIGINT NULL,                -- FK added after users exists
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);

CREATE TABLE rooms (
    id                       INT UNSIGNED AUTO_INCREMENT,
    room_number              VARCHAR(100) NOT NULL,
    -- Required on every room. The DEFAULT is deliberate: this server runs
    -- without STRICT_TRANS_TABLES, so a NOT NULL column with no default would
    -- silently accept 0. AdminController.validateFloor is what enforces it.
    floor_number             TINYINT UNSIGNED NOT NULL DEFAULT 1,
    department_id            TINYINT UNSIGNED NOT NULL,
    room_type                ENUM('Laboratory', 'Faculty Office', 'Consultation Room', 'Lecture', 'Faculty Lounge') DEFAULT 'Lecture',
    assigned_faculty         BIGINT NULL,   -- FK added after users exists
    is_ble_scanner_installed TINYINT(1) DEFAULT 0,
    -- One global cutoff fits no room exactly: a large laboratory with the
    -- scanner at one end and a small consultation room need different numbers.
    -- NULL keeps a room on app_settings.presence_rssi_threshold, so nothing has
    -- to be tuned until it actually needs tuning.
    rssi_threshold           SMALLINT NULL,
    capacity                 TINYINT UNSIGNED DEFAULT NULL,
    status                   ENUM('Active', 'Inactive') DEFAULT 'Active',
    created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (department_id) REFERENCES departments(id),
    INDEX idx_room_floor (department_id, floor_number)
);

CREATE TABLE users (
    id                  BIGINT AUTO_INCREMENT,
    public_id           CHAR(36) DEFAULT (UUID()) NOT NULL,
    first_name          VARCHAR(100) NOT NULL,
    middle_name         VARCHAR(100) NULL,
    last_name           VARCHAR(100) NOT NULL,
    email               VARCHAR(100) NOT NULL,
    institutional_id    VARCHAR(50)  NULL,
    hashed_password     VARCHAR(255) NULL,   -- NULL for Google-provisioned accounts
    role                ENUM('Student', 'Instructor', 'Dean', 'Admin') DEFAULT 'Student',
    employment_type     ENUM('Job Order', 'Permanent', 'Co-Terminus', 'Casual', 'COS', 'Temporary') NULL DEFAULT NULL,
    department_id       TINYINT UNSIGNED NULL,
    base_room_id        INT UNSIGNED NULL,   -- faculty base office; Faculty Lounge is the default
    position            VARCHAR(100) NULL,
    status              ENUM('Active', 'Inactive') DEFAULT 'Active',
    availability_status ENUM('available', 'dnd', 'travel', 'leave', 'meeting') DEFAULT NULL,
    last_login          TIMESTAMP NULL DEFAULT NULL,
    profile_picture     VARCHAR(255) NULL,
    default_meeting_link VARCHAR(255) NULL,   -- personal meeting room, reused for online consultations
    calendar_feed_token  CHAR(43) NULL,       -- credential for the outbound ICS feed; per-user so one can be revoked alone
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (base_room_id)  REFERENCES rooms(id) ON DELETE SET NULL,
    UNIQUE KEY idx_users_public_id (public_id),
    UNIQUE KEY idx_users_email (email),
    UNIQUE KEY idx_users_feed_token (calendar_feed_token)
);

-- Back-references, now that users exists
ALTER TABLE departments
    ADD CONSTRAINT fk_dept_dean FOREIGN KEY (dean_id) REFERENCES users(id);

ALTER TABLE rooms
    ADD CONSTRAINT fk_room_faculty FOREIGN KEY (assigned_faculty) REFERENCES users(id) ON DELETE SET NULL;

-- One-time passcodes for the second step of administrator login.
-- Codes are stored hashed; the plaintext exists only in the email.
CREATE TABLE otp_codes (
    id          BIGINT AUTO_INCREMENT,
    user_id     BIGINT NOT NULL,
    code_hash   VARCHAR(255) NOT NULL,
    expires_at  DATETIME NOT NULL,
    attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
    consumed_at DATETIME NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_otp_active (user_id, consumed_at, expires_at)
);

-- ------------------------------------------------------------
-- Consultation scheduling
-- ------------------------------------------------------------

CREATE TABLE consultation_hours (
    id                INT AUTO_INCREMENT,
    instructor_id     BIGINT NOT NULL,
    recurrence_id     CHAR(36) NULL,        -- shared by every slot in a weekly repeat series
    day_of_the_week   ENUM('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday') NOT NULL,
    consultation_date DATE NOT NULL,
    start_time        TIME NOT NULL,
    end_time          TIME NOT NULL,
    status            ENUM('Pending', 'Available', 'Booked', 'closed') DEFAULT 'Available',
    is_booked         TINYINT(1) NOT NULL DEFAULT 0,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_slot (instructor_id, consultation_date, start_time),
    INDEX idx_recurrence_id (recurrence_id)
);

-- Short-lived holds placed while a student fills in the booking form
CREATE TABLE slot_reservations (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    slot_id    INT NOT NULL,
    student_id BIGINT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_slot (slot_id),
    FOREIGN KEY (slot_id)    REFERENCES consultation_hours(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE instructor_unavailability (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    instructor_id BIGINT NOT NULL,
    unavail_date  DATE NOT NULL,
    reason        VARCHAR(300) NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_unavail_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_unavail (instructor_id, unavail_date)
);

CREATE TABLE appointments (
    id                   BIGINT AUTO_INCREMENT,
    consultation_hour_id INT NOT NULL,
    student_id           BIGINT NOT NULL,
    instructor_id        BIGINT NOT NULL,
    room_id              INT UNSIGNED NULL,   -- assigned only for Face-to-Face
    rescheduled_to_id    BIGINT NULL,
    rescheduled_from_id  BIGINT NULL,
    student_number       VARCHAR(50)  NOT NULL,
    section_group_name   VARCHAR(50)  NOT NULL,
    course_subject       VARCHAR(100) NOT NULL,
    email                VARCHAR(255) NOT NULL,
    topic                VARCHAR(255) NOT NULL,
    mode                 ENUM('Face-to-Face', 'Online') NOT NULL,
    notes                TEXT NULL,
    decline_reason       TEXT NULL,
    meeting_link         VARCHAR(255) NULL,   -- set when mode = Online
    google_event_id      VARCHAR(255) NULL,   -- Calendar event behind a scheduled Meet, so it can be cancelled
    completed_at         DATETIME NULL,
    reminder_sent        TINYINT(1) NOT NULL DEFAULT 0,
    completion_nudged_at DATETIME NULL,       -- last "please mark complete" nudge
    pending_nudged_at    DATETIME NULL,       -- last "this request is still waiting" nudge
    dean_escalated_at    DATETIME NULL,       -- set once the dean has been told it went unanswered
    -- 'expired' is set by jobs/reminder.js once the consultation's end time has
    -- passed while still pending. It keeps "never answered" apart from "waiting
    -- for an answer", which is what lets the pages stop offering Approve and
    -- Decline on a slot that is already behind us. Deliberately absent from
    -- SLOT_HOLDING_STATUSES, so an unanswered request stops holding its slot.
    status               ENUM('pending','confirmed','completed','cancelled','declined','rescheduled','expired') NOT NULL DEFAULT 'pending',
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (consultation_hour_id) REFERENCES consultation_hours(id) ON DELETE RESTRICT,
    FOREIGN KEY (student_id)           REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (instructor_id)        REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (room_id)              REFERENCES rooms(id) ON DELETE SET NULL,
    FOREIGN KEY (rescheduled_to_id)    REFERENCES appointments(id) ON DELETE SET NULL,
    FOREIGN KEY (rescheduled_from_id)  REFERENCES appointments(id) ON DELETE SET NULL,
    INDEX idx_appt_instructor (instructor_id, status),
    INDEX idx_appt_student (student_id, status)
);

-- ------------------------------------------------------------
-- Google Calendar connections
--
-- One row per instructor who has connected their own calendar, which is what
-- lets an online consultation get a real scheduled Meet instead of reusing
-- users.default_meeting_link. Per instructor rather than one shared service
-- account: the instructor has to be the host of their own consultation.
--
-- refresh_token is stored encrypted by services/google-crypto.js.
-- ------------------------------------------------------------

CREATE TABLE google_accounts (
    user_id       BIGINT NOT NULL,
    google_email  VARCHAR(255) NOT NULL,
    refresh_token TEXT NOT NULL,          -- AES-256-GCM, never plaintext
    access_token  TEXT NULL,              -- cached so a booking skips a refresh round-trip
    expires_at    DATETIME NULL,
    scope         TEXT NULL,
    last_error    VARCHAR(255) NULL,      -- set when Google rejects the refresh token
    connected_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_google_account_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- Teaching workload timetable
-- ------------------------------------------------------------

CREATE TABLE workload_subjects (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    instructor_id BIGINT NOT NULL,
    subject_code  VARCHAR(30)  NOT NULL,
    subject_name  VARCHAR(150) NOT NULL,
    color_hex     VARCHAR(20)  NULL,
    units         DECIMAL(4,1) NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ws_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_ws (instructor_id, subject_code)
);

CREATE TABLE workload_blocks (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    instructor_id BIGINT NOT NULL,
    subject_id    BIGINT UNSIGNED NOT NULL,
    day_of_week   ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') NOT NULL,
    start_slot    TINYINT UNSIGNED NOT NULL,
    end_slot      TINYINT UNSIGNED NOT NULL,
    room_id       INT UNSIGNED NULL,
    section_name  VARCHAR(80)  NULL,
    class_type    VARCHAR(40)  NULL,
    color_hex     VARCHAR(20)  NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_wb_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wb_subject    FOREIGN KEY (subject_id)    REFERENCES workload_subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL,
    UNIQUE KEY uq_wb_slot (instructor_id, day_of_week, start_slot),
    CHECK (end_slot > start_slot)
);

-- ------------------------------------------------------------
-- Presence monitoring (BLE)
--
-- A battery tag on each instructor, and an ESP32 scanner in each room that
-- reports what it can hear. The scanners decide nothing: they post signal
-- strengths and controllers/PresenceController.js works out who is where,
-- so the rules live in one place and can be changed without reflashing a board.
--
-- Presence never touches users.availability_status. What a scanner observed and
-- what an instructor said about themselves are two separate facts, and nothing
-- in this system derives one from the other.
-- ------------------------------------------------------------

-- One row per physical scanner, upserted on every report. A room going dark
-- then shows up as a stale row rather than as tags that mysteriously went
-- quiet — which is what tells a dead scanner apart from an empty room.
CREATE TABLE ble_scanners (
    id                INT UNSIGNED AUTO_INCREMENT,
    scanner_id        VARCHAR(60) NOT NULL,     -- the board's own ID, set in firmware
    room_id           INT UNSIGNED NULL,        -- matched from the room name it reports
    last_seen_at      DATETIME NULL,
    last_uptime_sec   INT UNSIGNED NULL,
    last_beacon_count SMALLINT UNSIGNED NULL,
    last_ip           VARCHAR(45) NULL,
    report_count      INT UNSIGNED NOT NULL DEFAULT 0,
    first_seen_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_scanner (scanner_id),
    CONSTRAINT fk_scanner_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL
);

-- The tags themselves. A tag is bound to at most one instructor, and an
-- instructor to at most one tag, so presence always resolves to one person.
--
-- Unknown addresses are only written down while an admin has opened a discovery
-- window: a scanner hears every phone that walks past, and most of those
-- addresses rotate every few minutes, so recording them filled the table
-- without ever yielding anything assignable.
CREATE TABLE ble_beacons (
    id            INT UNSIGNED AUTO_INCREMENT,
    mac_address   CHAR(17) NOT NULL,
    instructor_id BIGINT NULL,               -- NULL until an admin assigns it
    label         VARCHAR(80) NULL,          -- e.g. "CCS Tag 01"
    ibeacon_major SMALLINT UNSIGNED NULL,
    ibeacon_minor SMALLINT UNSIGNED NULL,
    battery_pct   TINYINT UNSIGNED NULL,
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    last_seen_at  DATETIME NULL,
    last_room_id  INT UNSIGNED NULL,
    last_rssi     SMALLINT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_beacon_mac (mac_address),
    UNIQUE KEY uq_beacon_instructor (instructor_id),
    CONSTRAINT fk_beacon_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_beacon_last_room  FOREIGN KEY (last_room_id)  REFERENCES rooms(id) ON DELETE SET NULL
);

-- Raw signal history, so a room's threshold can be measured instead of guessed.
--
-- presence_logs records the strength at the moment somebody crossed a line,
-- which is exactly the wrong sample for calibration: one reading, taken at the
-- instant the tag happened to cross. Tuning needs the spread of readings from
-- where a person actually sits — the weakest especially, because that is what a
-- threshold has to clear.
--
-- Throttled on write and pruned by jobs/reminder.js, so this stays a rolling
-- window rather than growing forever.
CREATE TABLE ble_rssi_samples (
    id         BIGINT UNSIGNED AUTO_INCREMENT,
    beacon_id  INT UNSIGNED NOT NULL,
    room_id    INT UNSIGNED NULL,
    scanner_id VARCHAR(60) NULL,
    rssi       SMALLINT NOT NULL COMMENT 'dBm, smoothed by the scanner',
    sampled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_samples_beacon_time (beacon_id, sampled_at),
    KEY idx_samples_room_time (room_id, sampled_at),
    CONSTRAINT fk_samples_beacon FOREIGN KEY (beacon_id) REFERENCES ble_beacons(id) ON DELETE CASCADE,
    CONSTRAINT fk_samples_room   FOREIGN KEY (room_id)   REFERENCES rooms(id) ON DELETE SET NULL
);

-- The movement history the dean's Presence Logs page reads. Append-only, and
-- separate from faculty_presence, which holds only the current state.
CREATE TABLE presence_logs (
    id            BIGINT UNSIGNED AUTO_INCREMENT,
    instructor_id BIGINT NOT NULL,
    room_id       INT UNSIGNED NULL,
    event         ENUM('entered', 'exited', 'moved') NOT NULL,
    rssi          SMALLINT NULL,          -- NULL on an exit: nothing was heard
    scanner_id    VARCHAR(60) NULL,
    occurred_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_plog_instructor_time (instructor_id, occurred_at),
    KEY idx_plog_time (occurred_at),
    CONSTRAINT fk_plog_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_plog_room       FOREIGN KEY (room_id)       REFERENCES rooms(id) ON DELETE SET NULL
);

-- Who each room currently holds. One row per instructor, updated in place.
CREATE TABLE faculty_presence (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    instructor_id BIGINT NOT NULL,
    room_id       INT UNSIGNED NULL,
    is_present    TINYINT(1) NOT NULL DEFAULT 0,
    -- The reading the owning room heard. Two scanners can hear one tag, and
    -- without this the room that POSTed last won — so presence flipped between
    -- adjacent rooms every few seconds. The room that hears the tag best owns
    -- it, and this is what the comparison is made against.
    last_rssi     SMALLINT NULL,
    detected_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_updated  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_presence_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_presence_room       FOREIGN KEY (room_id)       REFERENCES rooms(id) ON DELETE SET NULL,
    UNIQUE KEY uq_presence_instructor (instructor_id)  -- one row per instructor
);

-- ------------------------------------------------------------
-- Notifications and auditing
-- ------------------------------------------------------------

CREATE TABLE notifications (
    id                     BIGINT AUTO_INCREMENT,
    user_id                BIGINT NOT NULL,
    -- 'expired' is its own type rather than reusing 'declined': nobody declined
    -- it, and the student needs to know the difference.
    type                   ENUM('new-request','cancellation','unavailability','reminder','makeup','alert','approved','declined','rescheduled','expired') NOT NULL,
    message                VARCHAR(255) NOT NULL,
    related_appointment_id BIGINT NULL,
    is_read                TINYINT(1) NOT NULL DEFAULT 0,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id)                REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (related_appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
    INDEX idx_user_unread (user_id, is_read),
    INDEX idx_user_created (user_id, created_at)
);

-- Web Push subscriptions (PWA device notifications).
-- One row per browser/device a user has enabled notifications on, so a single
-- user with a phone and a laptop gets pushed to on both.
CREATE TABLE push_subscriptions (
    id         BIGINT AUTO_INCREMENT,
    user_id    BIGINT NOT NULL,
    endpoint   VARCHAR(500) NOT NULL,   -- unique per browser install
    p256dh     VARCHAR(255) NOT NULL,   -- client public key
    auth       VARCHAR(255) NOT NULL,   -- client auth secret
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_push_endpoint (endpoint),
    INDEX idx_push_user (user_id)
);

-- Per-instructor preferences set from Instructor > Settings.
-- A missing row means "all defaults", so an account never has to be seeded.
CREATE TABLE instructor_settings (
    user_id              BIGINT NOT NULL,
    notify_new_requests  TINYINT(1) NOT NULL DEFAULT 1,
    notify_cancellations TINYINT(1) NOT NULL DEFAULT 1,
    notify_reminders     TINYINT(1) NOT NULL DEFAULT 1,
    notify_ble_absence   TINYINT(1) NOT NULL DEFAULT 0,
    notify_announcements TINYINT(1) NOT NULL DEFAULT 1,
    repeat_weekly        TINYINT(1) NOT NULL DEFAULT 1,   -- new consultation slots repeat by default
    repeat_weeks         TINYINT UNSIGNED NOT NULL DEFAULT 4,
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Per-student preferences set from Student > Settings.
-- Same "missing row means all defaults" rule as instructor_settings.
CREATE TABLE student_settings (
    user_id            BIGINT NOT NULL,
    -- Open the faculty directory filtered to the student's own department.
    -- A default, not a restriction: every department stays selectable.
    directory_own_dept TINYINT(1) NOT NULL DEFAULT 0,
    updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- Make-up class requests
--
-- One request carries N proposed sessions and gets a single dean
-- decision. Approved sessions stay here rather than in workload_blocks:
-- that table is a recurring weekly grid keyed (instructor, day, start_slot),
-- so a one-off dated class written there would repeat forever and collide
-- with the very class it replaces. Views merge the two per week.
-- ------------------------------------------------------------

CREATE TABLE makeup_requests (
    id                     CHAR(36) NOT NULL,          -- exposed in URLs
    instructor_id          BIGINT NOT NULL,
    department_id          TINYINT UNSIGNED NULL,      -- snapshot: routes the dean's queue
    reason                 VARCHAR(500) NULL,
    status                 ENUM('pending', 'approved', 'declined', 'withdrawn', 'expired') NOT NULL DEFAULT 'pending',  -- expired: see migrations/2026-09-27-makeup-expired.sql
    decided_by             BIGINT NULL,
    dean_statement         VARCHAR(500) NULL,
    decline_reason         VARCHAR(500) NULL,
    decided_at             DATETIME NULL,
    submitted_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- ms precision: the dean's queue is first-come, first-served
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (instructor_id) REFERENCES users(id)       ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (decided_by)    REFERENCES users(id)       ON DELETE SET NULL,
    INDEX idx_mr_queue (department_id, status, submitted_at),
    INDEX idx_mr_instructor (instructor_id, status)
);

-- Supporting PDFs and the polling sheet. One request carries several, so
-- the files live here rather than in columns on makeup_requests.
CREATE TABLE makeup_request_documents (
    id            CHAR(36) NOT NULL,
    request_id    CHAR(36) NOT NULL,
    kind          ENUM('support', 'polling') NOT NULL DEFAULT 'support',
    file_path     VARCHAR(255) NOT NULL,      -- stored outside public/
    original_name VARCHAR(255) NOT NULL,      -- what the instructor called it
    mime_type     VARCHAR(120) NOT NULL,
    size_bytes    INT UNSIGNED NOT NULL DEFAULT 0,
    uploaded_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- ms precision keeps the attachment order stable
    PRIMARY KEY (id),
    FOREIGN KEY (request_id) REFERENCES makeup_requests(id) ON DELETE CASCADE,
    INDEX idx_mrd_request (request_id, kind)
);

CREATE TABLE makeup_request_schedules (
    id                BIGINT UNSIGNED AUTO_INCREMENT,
    request_id        CHAR(36) NOT NULL,
    workload_block_id BIGINT UNSIGNED NULL,   -- the missed class, when picked from the timetable
    subject_code      VARCHAR(30)  NOT NULL,
    subject_name      VARCHAR(150) NOT NULL,
    section_name      VARCHAR(80)  NOT NULL,
    class_type        VARCHAR(40)  NULL,
    delivery_mode     ENUM('in-campus', 'online') NOT NULL DEFAULT 'in-campus',
    class_date        DATE NOT NULL,          -- the make-up happens once, on this date
    day_of_week       ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') NOT NULL,
    start_slot        TINYINT UNSIGNED NOT NULL,   -- half-hour slots, as in workload_blocks
    end_slot          TINYINT UNSIGNED NOT NULL,
    room_id           INT UNSIGNED NULL,      -- NULL for online sessions
    PRIMARY KEY (id),
    FOREIGN KEY (request_id)        REFERENCES makeup_requests(id) ON DELETE CASCADE,
    FOREIGN KEY (workload_block_id) REFERENCES workload_blocks(id) ON DELETE SET NULL,
    FOREIGN KEY (room_id)           REFERENCES rooms(id)           ON DELETE SET NULL,
    INDEX idx_mrs_request (request_id),
    INDEX idx_mrs_when (class_date, start_slot),
    INDEX idx_mrs_room (room_id, class_date),
    CHECK (end_slot > start_slot)
);

-- ------------------------------------------------------------
-- External calendar sync (Google / Apple / any ICS feed)
--
-- Instructors subscribe FaciTrack to a calendar feed; the events land in
-- external_events and are drawn on the appointments calendar. An event may
-- also block the slot it covers, so students cannot book over it.
--
-- Times are stored the way the rest of the system stores them: a local
-- (Asia/Manila) date plus half-hour slot indices, matching workload_blocks
-- and makeup_request_schedules. An event crossing midnight is split into one
-- row per day so that model always holds.
-- ------------------------------------------------------------

CREATE TABLE calendar_connections (
    id             CHAR(36) NOT NULL,
    user_id        BIGINT NOT NULL,
    provider       ENUM('google', 'apple', 'other') NOT NULL DEFAULT 'other',
    display_name   VARCHAR(120) NOT NULL,
    -- Both NULL for a Google connection, which authenticates with OAuth and has
    -- no feed URL at all. Set only for a subscribed ICS feed.
    feed_url       VARBINARY(1024) NULL,       -- encrypted: the URL is a bearer secret
    feed_hint      VARCHAR(80) NULL,           -- masked tail, safe to show back
    auto_sync      TINYINT(1) NOT NULL DEFAULT 1,
    blocking_rule  ENUM('always', 'never', 'ask') NOT NULL DEFAULT 'ask',
    import_titles  TINYINT(1) NOT NULL DEFAULT 1,   -- off = busy times only
    etag           VARCHAR(255) NULL,          -- conditional GET, so a poll is cheap
    last_modified  VARCHAR(255) NULL,
    last_synced_at DATETIME NULL,
    last_status    ENUM('never', 'ok', 'error') NOT NULL DEFAULT 'never',
    last_error     VARCHAR(300) NULL,
    event_count    INT UNSIGNED NOT NULL DEFAULT 0,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_cc_user (user_id),
    INDEX idx_cc_due (auto_sync, last_synced_at)
);

CREATE TABLE external_events (
    id            BIGINT UNSIGNED AUTO_INCREMENT,
    connection_id CHAR(36) NOT NULL,
    user_id       BIGINT NOT NULL,
    uid           VARCHAR(255) NOT NULL,   -- the feed's own id, stable across syncs
    occurrence    VARCHAR(32)  NOT NULL,   -- which instance of a repeating event
    summary       VARCHAR(255) NULL,       -- NULL when the feed is busy-times-only
    location      VARCHAR(255) NULL,
    event_date    DATE NOT NULL,           -- Asia/Manila wall-clock
    start_slot    TINYINT UNSIGNED NULL,   -- NULL for an all-day event
    end_slot      TINYINT UNSIGNED NULL,
    all_day       TINYINT(1) NOT NULL DEFAULT 0,
    transparent   TINYINT(1) NOT NULL DEFAULT 0,   -- the feed marked it "free"
    blocks        TINYINT(1) NOT NULL DEFAULT 0,
    decision      ENUM('auto', 'pending', 'user') NOT NULL DEFAULT 'auto',
    -- Millisecond precision on purpose: the prune compares against the
    -- timestamp of the sync that just ran, and a second-precision column would
    -- truncate it and delete the rows that sync had only just written.
    last_seen_at  DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (connection_id) REFERENCES calendar_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)       REFERENCES users(id) ON DELETE CASCADE,
    -- One row per instance per day. Re-syncing upserts on this key rather than
    -- wiping the table, so a decision the instructor made is never lost.
    UNIQUE KEY uq_ee_instance (connection_id, uid, occurrence),
    INDEX idx_ee_when (user_id, event_date),
    INDEX idx_ee_blocking (user_id, blocks, event_date),
    INDEX idx_ee_pending (user_id, decision)
);

CREATE TABLE instructor_events (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    instructor_id BIGINT NOT NULL,
    kind          ENUM('event', 'task') NOT NULL DEFAULT 'event',
    title         VARCHAR(200) NOT NULL,
    notes         VARCHAR(500) NULL,
    event_date    DATE NOT NULL,
    -- Half-hour indices, as in workload_blocks and external_events:
    -- hour * 2 + (minute >= 30 ? 1 : 0). NULL on an all-day entry.
    start_slot    TINYINT UNSIGNED NULL,
    end_slot      TINYINT UNSIGNED NULL,
    all_day       TINYINT(1) NOT NULL DEFAULT 0,
    -- Whether students are barred from booking the hours it covers. A task is
    -- usually a personal reminder and does not block; an event usually does.
    blocks        TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_inst_event_user FOREIGN KEY (instructor_id)
        REFERENCES users(id) ON DELETE CASCADE,
    -- The availability check filters by instructor and date on every slot query
    INDEX idx_inst_event_day (instructor_id, event_date),
    INDEX idx_inst_event_blocking (instructor_id, blocks, event_date)
);

CREATE TABLE audit_logs (
    id         BIGINT AUTO_INCREMENT,
    user_id    BIGINT NULL,
    role       VARCHAR(20)  NULL,
    action     VARCHAR(150) NOT NULL,
    type       VARCHAR(30)  NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_user (user_id),
    INDEX idx_type (type),
    INDEX idx_created (created_at)
);

-- ------------------------------------------------------------
-- The Faculty Lounge display board
--
-- A screen on a wall outside the lounge, showing who is in. It has no account
-- and nobody signs in to it, so it identifies itself with a long random token
-- in a cookie — stored here only as a SHA-256 hash, so a copy of this table is
-- not a set of working keys.
--
-- A new screen shows a pairing code and nothing else until an admin approves it
-- to a department. That approval is the whole access control: without it the
-- board is never sent a single name.
-- ------------------------------------------------------------

CREATE TABLE display_devices (
    id              BIGINT UNSIGNED AUTO_INCREMENT,
    device_token    CHAR(64) NOT NULL,        -- sha256 of the cookie value
    pairing_code    CHAR(6) NULL,             -- shown on screen until approved
    code_expires_at DATETIME NULL,            -- a lapsed code is reissued on its own
    label           VARCHAR(120) NULL,
    department_id   TINYINT UNSIGNED NULL,    -- whose faculty this board shows
    status          ENUM('pending', 'approved', 'revoked') NOT NULL DEFAULT 'pending',
    approved_by     BIGINT NULL,
    approved_at     DATETIME NULL,
    user_agent      VARCHAR(255) NULL,        -- helps an admin tell two screens apart
    last_seen_at    DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_display_token (device_token),
    UNIQUE KEY uq_display_code (pairing_code),
    INDEX idx_display_status (status),
    CONSTRAINT fk_display_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_display_approver   FOREIGN KEY (approved_by)   REFERENCES users(id)       ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- System settings
--
-- Values an administrator can change without a redeploy: booking lead time,
-- the presence thresholds and timeouts, whether email and device notifications
-- are sent. services/app-settings.js holds the definition of each key — its
-- type, its bounds and the .env variable it falls back to — so a missing row
-- means "use the default" and a fresh install needs no seeding.
--
-- Keyed by name rather than one row of columns: adding a setting is then a code
-- change in one file, not a migration.
-- ------------------------------------------------------------

CREATE TABLE app_settings (
    setting_key   VARCHAR(60) NOT NULL,
    setting_value VARCHAR(255) NOT NULL,
    updated_by    BIGINT NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (setting_key),
    CONSTRAINT fk_app_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Uploaded files (profile photos, make-up documents). On a server these live on
-- disk; on a serverless host, which has no writable disk, they live here. Bytes
-- are split into 256 KB chunks so no statement approaches max_allowed_packet.
-- See services/file-store.js.
CREATE TABLE stored_files (
    file_key      VARCHAR(255) NOT NULL,
    kind          VARCHAR(32)  NOT NULL,
    mime_type     VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
    original_name VARCHAR(255) NULL,
    byte_size     INT UNSIGNED NOT NULL DEFAULT 0,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (file_key),
    INDEX idx_stored_files_kind (kind, created_at)
);

CREATE TABLE stored_file_chunks (
    file_key    VARCHAR(255) NOT NULL,
    chunk_index INT UNSIGNED NOT NULL,
    data        MEDIUMBLOB   NOT NULL,
    PRIMARY KEY (file_key, chunk_index),
    CONSTRAINT fk_chunk_file FOREIGN KEY (file_key)
        REFERENCES stored_files (file_key) ON DELETE CASCADE
);
