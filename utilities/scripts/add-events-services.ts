import 'dotenv/config';
import { DatabaseStorage } from '../../server/storage';

async function main() {
  const storage = new DatabaseStorage();

  // Create the Events submenu
  const eventsSubmenu = await storage.createCategory({
    name: '🎟️ Events',
    isSubmenu: true,
    questions: [],
    serviceSummary: 'Book tickets for events, concerts, and theme parks.',
    displayOrder: 40,
    newRow: false,
  });
  const eventsId = eventsSubmenu.id;

  // Add child services
  await storage.createCategory({
    name: '🎫 Ticketmaster',
    parentId: eventsId,
    questions: ['What event do you want tickets for? Which date and location?'],
    serviceSummary: 'Buy tickets for concerts, sports, and more via Ticketmaster.',
    displayOrder: 1,
  });
  await storage.createCategory({
    name: '🎟️ SeatGeek',
    parentId: eventsId,
    questions: ['What event do you want tickets for? Which date and location?'],
    serviceSummary: 'Find and buy tickets for events via SeatGeek.',
    displayOrder: 2,
  });
  await storage.createCategory({
    name: '🎢 Theme Parks',
    parentId: eventsId,
    questions: ['Which theme park? What date? How many tickets?'],
    serviceSummary: 'Book tickets for theme parks like Disney, Universal, and more.',
    displayOrder: 3,
  });

  console.log('Events submenu and services added successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}); 