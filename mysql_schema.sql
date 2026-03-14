-- =====================================================
-- MiniSaaS / CodeXcel - MySQL Schema
-- Import this file in phpMyAdmin (NOT the .sqlite file)
-- =====================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

-- Users Table
CREATE TABLE IF NOT EXISTS `users` (
    `id`            INT(11)      NOT NULL AUTO_INCREMENT,
    `email`         VARCHAR(255) NOT NULL UNIQUE,
    `password_hash` TEXT         NOT NULL,
    `businessName`  VARCHAR(255) DEFAULT NULL,
    `agentName`     VARCHAR(255) DEFAULT NULL,
    `apiKey`        TEXT         DEFAULT NULL,
    `context`       TEXT         DEFAULT NULL,
    `plan_id`       VARCHAR(50)  DEFAULT 'free',
    `is_paid`       TINYINT(1)   DEFAULT 0,
    `created_at`    DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quotas Table
CREATE TABLE IF NOT EXISTS `quotas` (
    `user_id`       INT(11)  NOT NULL,
    `chats_used`    INT(11)  DEFAULT 0,
    `message_limit` INT(11)  DEFAULT 10,
    `reset_date`    DATETIME DEFAULT NULL,
    PRIMARY KEY (`user_id`),
    CONSTRAINT `fk_quotas_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
