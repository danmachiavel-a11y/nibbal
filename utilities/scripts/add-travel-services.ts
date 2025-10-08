import 'dotenv/config';
import { DatabaseStorage } from '../../server/storage';

async function main() {
  const storage = new DatabaseStorage();

  // Create the Travel submenu
  const travelSubmenu = await storage.createCategory({
    name: '🧳 Travel',
    isSubmenu: true,
    questions: [],
    serviceSummary: 'Book travel and accommodation services.',
    displayOrder: 20,
    newRow: false,
  });
  const travelId = travelSubmenu.id;

  // Add child services
  await storage.createCategory({
    name: '🏨 Hotels',
    parentId: travelId,
    questions: ['Where and when do you need a hotel?'],
    serviceSummary: 'Book hotels worldwide.',
    displayOrder: 1,
  });
  await storage.createCategory({
    name: '✈️ Flights',
    parentId: travelId,
    questions: ['Where are you flying from and to? What dates?'],
    serviceSummary: 'Book flights to any destination.',
    displayOrder: 2,
  });
  await storage.createCategory({
    name: '🏠 Airbnb',
    parentId: travelId,
    questions: ['Where and when do you need an Airbnb?'],
    serviceSummary: 'Book Airbnb stays.',
    displayOrder: 3,
  });
  await storage.createCategory({
    name: '🚗 Car Rentals',
    parentId: travelId,
    questions: ['Where and when do you need a rental car?'],
    serviceSummary: 'Rent a car for your trip.',
    displayOrder: 4,
  });
  await storage.createCategory({
    name: '🚌🚆 Bus/Train Tickets',
    parentId: travelId,
    questions: ['Where are you traveling from and to? What date and time?'],
    serviceSummary: 'Book bus or train tickets for your journey.',
    displayOrder: 5,
  });
  await storage.createCategory({
    name: '🚕 Uber Rides',
    parentId: travelId,
    questions: ['Where do you want to be picked up and dropped off? What time?'],
    serviceSummary: 'Book an Uber ride for your trip.',
    displayOrder: 6,
  });
  await storage.createCategory({
    name: '🛳️ Cruises',
    parentId: travelId,
    questions: ['Where and when do you want to go on a cruise? Any preferences?'],
    serviceSummary: 'Book cruise vacations and trips.',
    displayOrder: 7,
  });
  // Add more travel-related services as needed

  console.log('Travel submenu and services added successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}); 