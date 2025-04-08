-- Raw SQL script for closing tickets by Telegram ID
-- Usage: psql -f raw-close.sql -v telegram_id=1933230287

-- Create a temporary function that finds and closes the most recent active ticket
DO $$
DECLARE
    v_user_id INT;
    v_ticket_id INT;
    v_ticket_status TEXT;
    v_telegram_id TEXT := :'telegram_id';
BEGIN
    -- Get the user ID
    SELECT id INTO v_user_id 
    FROM users 
    WHERE telegram_id = v_telegram_id;
    
    IF v_user_id IS NULL THEN
        RAISE NOTICE 'User with Telegram ID % not found', v_telegram_id;
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
END $$;