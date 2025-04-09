/**
 * Test script to verify ticket closing functionality
 * 
 * This script directly closes a ticket by ID to test the updateTicketStatus method
 * Usage: node test-close-handler.js [ticketId]
 */

import { db } from './server/db.js';
import { storage } from './server/storage.js';

/**
 * Close a ticket directly using the storage interface
 * @param {number} ticketId The ID of the ticket to close
 */
async function testCloseTicket(ticketId) {
  try {
    console.log(`Starting test close for ticket ID: ${ticketId}`);
    
    // Get the ticket first
    const ticket = await storage.getTicket(ticketId);
    
    if (!ticket) {
      console.error(`❌ Ticket ${ticketId} not found`);
      return;
    }
    
    console.log(`Found ticket: ${JSON.stringify(ticket)}`);
    
    // Update the ticket status
    console.log(`Closing ticket ${ticketId}...`);
    await storage.updateTicketStatus(ticketId, "closed");
    
    // Verify the update
    const updatedTicket = await storage.getTicket(ticketId);
    console.log(`Ticket after update: ${JSON.stringify(updatedTicket)}`);
    
    if (updatedTicket?.status === 'closed') {
      console.log(`✅ Ticket ${ticketId} was successfully closed!`);
    } else {
      console.error(`❌ Failed to close ticket ${ticketId} - status is still ${updatedTicket?.status}`);
    }
  } catch (error) {
    console.error(`❌ Error closing ticket: ${error}`);
  } finally {
    // Ensure we exit the process
    process.exit(0);
  }
}

// Get ticket ID from command line args
const ticketId = process.argv[2];

if (!ticketId || isNaN(parseInt(ticketId))) {
  console.error('❌ Please provide a valid ticket ID as a command line argument');
  process.exit(1);
}

// Run the test
testCloseTicket(parseInt(ticketId));