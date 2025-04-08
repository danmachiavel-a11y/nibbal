#!/bin/bash
# Simple shell script to close a ticket by Telegram ID

# Check if Telegram ID is provided
if [ -z "$1" ]; then
  echo "Usage: ./close-ticket.sh [TELEGRAM_ID]"
  exit 1
fi

TELEGRAM_ID=$1

# Load environment variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL environment variable not set"
  exit 1
fi

echo "Closing ticket for Telegram ID: $TELEGRAM_ID"

# Extract connection parameters from DATABASE_URL
DB_USER=$(echo $DATABASE_URL | sed -n 's/.*:\/\/\([^:]*\).*/\1/p')
DB_PASSWORD=$(echo $DATABASE_URL | sed -n 's/.*:\/\/[^:]*:\([^@]*\).*/\1/p')
DB_HOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\).*/\1/p')
DB_PORT=$(echo $DATABASE_URL | sed -n 's/.*:\([0-9]*\)\/.*/\1/p')
DB_NAME=$(echo $DATABASE_URL | sed -n 's/.*\/\([^?]*\).*/\1/p')

# Use PGPASSWORD environment variable for authentication
export PGPASSWORD=$DB_PASSWORD

# Execute SQL commands
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME << EOF
-- Find and close the most recent active ticket
DO \$\$
DECLARE
    v_user_id INT;
    v_ticket_id INT;
    v_ticket_status TEXT;
BEGIN
    -- Get the user ID
    SELECT id INTO v_user_id 
    FROM users 
    WHERE telegram_id = '$TELEGRAM_ID';
    
    IF v_user_id IS NULL THEN
        RAISE NOTICE 'User with Telegram ID % not found', '$TELEGRAM_ID';
        RETURN;
    END IF;
    
    RAISE NOTICE 'Found user with ID %', v_user_id;
    
    -- Find the most recent active ticket
    SELECT id, status INTO v_ticket_id, v_ticket_status
    FROM tickets
    WHERE user_id = v_user_id
    AND status NOT IN ('closed', 'completed', 'transcript')
    ORDER BY id DESC
    LIMIT 1;
    
    IF v_ticket_id IS NULL THEN
        RAISE NOTICE 'No active tickets found for user %', v_user_id;
        RETURN;
    END IF;
    
    RAISE NOTICE 'Found ticket % with status %', v_ticket_id, v_ticket_status;
    
    -- Close the ticket
    UPDATE tickets SET status = 'closed' WHERE id = v_ticket_id;
    
    RAISE NOTICE 'Successfully closed ticket %', v_ticket_id;
END \$\$;
EOF

echo "Operation complete!"