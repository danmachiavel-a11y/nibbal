-- Migration: Change telegram_id columns from bigint to text

ALTER TABLE users ALTER COLUMN telegram_id TYPE TEXT USING telegram_id::text;
ALTER TABLE user_states ALTER COLUMN telegram_id TYPE TEXT USING telegram_id::text;
ALTER TABLE message_queue ALTER COLUMN telegram_user_id TYPE TEXT USING telegram_user_id::text; 