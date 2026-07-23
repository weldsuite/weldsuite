-- Add missing columns to helpdesk_conversations table
-- These were added to the Drizzle schema but never migrated

ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(50);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS is_ticket BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS subcategory VARCHAR(100);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(30);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS ticket_type_id VARCHAR(30);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS severity VARCHAR(20);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS sla_id VARCHAR(30);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS response_deadline TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS resolution_deadline TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS sla_status VARCHAR(20);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS breached_at TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS response_time INTEGER;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS resolution_time INTEGER;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS satisfaction_rating INTEGER;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS satisfaction_comment TEXT;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS custom_fields JSONB;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS related_conversation_ids JSONB;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS parent_conversation_id VARCHAR(30);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS merged_conversation_ids JSONB;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS is_spam BOOLEAN DEFAULT false;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS is_escalated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS has_active_workflow BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS labels JSONB;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS attachment_count INTEGER DEFAULT 0;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP;
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS source_email VARCHAR(255);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS source_url VARCHAR(500);
ALTER TABLE helpdesk_conversations ADD COLUMN IF NOT EXISTS visitor_location JSONB;

-- Indexes for new columns
CREATE INDEX IF NOT EXISTS helpdesk_conversations_is_ticket_idx ON helpdesk_conversations (is_ticket);
CREATE INDEX IF NOT EXISTS helpdesk_conversations_ticket_number_idx ON helpdesk_conversations (ticket_number);
CREATE INDEX IF NOT EXISTS helpdesk_conversations_sla_status_idx ON helpdesk_conversations (sla_status);
CREATE INDEX IF NOT EXISTS helpdesk_conversations_category_idx ON helpdesk_conversations (category);
