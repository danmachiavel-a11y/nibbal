#!/bin/bash

# Emergency CLI Tool for Closing Tickets
#
# This script provides a simple command-line interface to close a ticket
# using the emergency API endpoint.
#
# Usage: ./close-ticket.sh [telegram_id]

# Text colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Telegram ID was provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Telegram ID is required${NC}"
  echo "Usage: $0 [telegram_id]"
  exit 1
fi

TELEGRAM_ID="$1"

# Display warning
echo -e "${RED}"
echo "========== EMERGENCY TICKET CLOSE UTILITY =========="
echo -e "${NC}"
echo -e "${YELLOW}WARNING: This is an emergency utility to close a ticket when other methods fail.${NC}"
echo -e "Attempting to close ticket for Telegram ID: ${GREEN}$TELEGRAM_ID${NC}"
echo ""

# Make API request to close the ticket
echo "Sending request to emergency close endpoint..."
curl -s -X POST "http://localhost:5000/api/tickets/close-by-telegram-id/$TELEGRAM_ID" | jq .

# Display help information
echo ""
echo -e "${YELLOW}If this tool fails, you can also try the following:${NC}"
echo "1. Use the emergency close web interface: http://localhost:5000/emergency-close"
echo "2. Run the node script directly: node super-close-command.js $TELEGRAM_ID"
echo "3. Run the direct database command: node direct-close-command.js $TELEGRAM_ID"
echo ""
echo "Thank you for using the emergency close utility."