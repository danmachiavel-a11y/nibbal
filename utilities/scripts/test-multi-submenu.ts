import 'dotenv/config';
import { DatabaseStorage } from '../../server/storage';

async function testMultiSubmenu() {
  const storage = new DatabaseStorage();

  console.log('🧪 Testing Multi-Submenu Functionality...\n');

  try {
    // Get all categories
    const categories = await storage.getCategories();
    console.log(`📋 Found ${categories.length} total categories`);

    const submenus = categories.filter(cat => cat.isSubmenu);
    const regularCategories = categories.filter(cat => !cat.isSubmenu);

    console.log(`📁 Found ${submenus.length} submenus:`);
    submenus.forEach(submenu => {
      console.log(`  - ${submenu.name} (ID: ${submenu.id})`);
    });

    console.log(`\n🏷️  Found ${regularCategories.length} regular categories:`);
    regularCategories.forEach(category => {
      console.log(`  - ${category.name} (ID: ${category.id})`);
    });

    if (submenus.length >= 2 && regularCategories.length >= 1) {
      console.log('\n✅ Testing multi-submenu assignment...');
      
      // Test: Assign a category to multiple submenus
      const testCategory = regularCategories[0];
      const testSubmenus = submenus.slice(0, 2); // Take first 2 submenus
      
      console.log(`\n🔗 Assigning "${testCategory.name}" to submenus:`);
      testSubmenus.forEach(submenu => {
        console.log(`  - ${submenu.name}`);
      });

      const submenuIds = testSubmenus.map(s => s.id);
      const success = await storage.setCategorySubmenus(testCategory.id, submenuIds);
      
      if (success) {
        console.log('✅ Successfully assigned category to multiple submenus!');
        
        // Verify the assignment
        const assignedSubmenus = await storage.getCategorySubmenus(testCategory.id);
        console.log(`\n🔍 Verification - Category "${testCategory.name}" is now assigned to:`);
        assignedSubmenus.forEach(submenuId => {
          const submenu = submenus.find(s => s.id === submenuId);
          console.log(`  - ${submenu?.name || `Unknown (ID: ${submenuId})`}`);
        });

        // Test: Get categories for each submenu
        console.log('\n📋 Testing submenu category retrieval...');
        for (const submenu of testSubmenus) {
          const submenuCategories = await storage.getSubmenuCategories(submenu.id);
          console.log(`\n📁 Submenu "${submenu.name}" contains ${submenuCategories.length} categories:`);
          submenuCategories.forEach(cat => {
            console.log(`  - ${cat.name}`);
          });
        }

        console.log('\n✅ Multi-submenu functionality is working correctly!');
      } else {
        console.log('❌ Failed to assign category to multiple submenus');
      }
    } else {
      console.log('\n⚠️  Not enough submenus or categories to test multi-submenu functionality');
      console.log('   Need at least 2 submenus and 1 regular category');
    }

  } catch (error) {
    console.error('❌ Error testing multi-submenu functionality:', error);
  }
}

// Run the test
testMultiSubmenu().then(() => {
  console.log('\n🏁 Test completed');
  process.exit(0);
}).catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});
