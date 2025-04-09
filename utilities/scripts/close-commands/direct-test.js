// Import modules
import { storage } from './server/storage.js';

// Test ticket ID from the SQL command (87)
const TEST_TICKET_ID = 87;

// Run the test
console.log(`Starting test for ticket ID: ${TEST_TICKET_ID}`);

async function testTicketClose() {
  try {
    // Verify the ticket exists
    const ticket = await storage.getTicket(TEST_TICKET_ID);
    console.log(`Found ticket: ${JSON.stringify(ticket)}`);
    
    if (!ticket) {
      console.error(`Ticket with ID ${TEST_TICKET_ID} not found`);
      return;
    }
    
    // Close the ticket
    console.log(`Attempting to close ticket ${TEST_TICKET_ID}`);
    await storage.updateTicketStatus(TEST_TICKET_ID, "closed");
    
    // Verify the ticket was closed
    const updatedTicket = await storage.getTicket(TEST_TICKET_ID);
    console.log(`Updated ticket: ${JSON.stringify(updatedTicket)}`);
    
    if (updatedTicket.status === 'closed') {
      console.log(`Success! Ticket ${TEST_TICKET_ID} was closed.`);
    } else {
      console.error(`Failed to close ticket. Status is still ${updatedTicket.status}`);
    }
  } catch (error) {
    console.error(`Error in test: ${error}`);
  }
}

testTicketClose();