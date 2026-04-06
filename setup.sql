-- ================================================================
--  CureBot Database Schema
--  Run this in MySQL Workbench or via:
--    mysql -u root -p < setup.sql
-- ================================================================

-- Create & select database
CREATE DATABASE IF NOT EXISTS curebot
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE curebot;

-- ── Users table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id         INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    name       VARCHAR(100)     NOT NULL,
    email      VARCHAR(255)     NOT NULL,
    password   VARCHAR(255)     NOT NULL,          -- bcrypt hash
    created_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── (Optional) Chat history table ───────────────────────────────
CREATE TABLE IF NOT EXISTS chat_logs (
    id         INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    user_id    INT UNSIGNED     NOT NULL,
    role       ENUM('user','bot') NOT NULL,
    message    TEXT             NOT NULL,
    created_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    CONSTRAINT fk_chatlogs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
