import { useSortable, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { 
  DndContext, 
  DragEndEvent, 
  MouseSensor, 
  TouchSensor, 
  useSensor, 
  useSensors,
  pointerWithin,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import type { Category } from "@shared/schema";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Trash2 } from "lucide-react";

interface SortableItemProps {
  id: number;
  category: Category;
  onNewRowToggle: (id: number) => void;
  onDeleteCategory: (id: number) => void;
}

function SortableItem({ id, category, onNewRowToggle, onDeleteCategory }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className="p-2 w-full sm:w-1/2"
    >
      <Card className="bg-white hover:bg-gray-50 transition-colors">
        <CardHeader className="p-3" {...listeners}>
          <div className="flex justify-between items-center">
            <CardTitle className="text-sm font-medium cursor-grab">{category.name}</CardTitle>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Category</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete the "{category.name}" category? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDeleteCategory(id)} className="bg-red-600 hover:bg-red-700">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent>
          <Button 
            variant={category.newRow ? "default" : "outline"}
            onClick={() => onNewRowToggle(id)}
            className="w-full"
          >
            Start New Row: {category.newRow ? "ON" : "OFF"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

interface CategoryGridProps {
  categories: Category[];
  onReorder: (categories: Category[]) => void;
}

export function CategoryGrid({ categories, onReorder }: CategoryGridProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor)
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const oldIndex = categories.findIndex(cat => cat.id === active.id);
    const newIndex = categories.findIndex(cat => cat.id === over.id);

    // Create new array with updated order
    const newCategories = [...categories];
    const [moved] = newCategories.splice(oldIndex, 1);
    newCategories.splice(newIndex, 0, moved);

    try {
      // Update display orders in the database
      const updatePromises = newCategories.map((category, index) => 
        fetch(`/api/categories/${category.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            displayOrder: index,
            // Include all existing properties to prevent overwriting
            name: category.name,
            discordRoleId: category.discordRoleId,
            discordCategoryId: category.discordCategoryId,
            questions: category.questions,
            serviceSummary: category.serviceSummary,
            serviceImageUrl: category.serviceImageUrl,
            newRow: category.newRow
          })
        })
      );

      // Wait for all updates to complete
      const results = await Promise.all(updatePromises);

      // Check if any update failed
      if (results.some(res => !res.ok)) {
        throw new Error('Failed to update some categories');
      }

      // Update local state
      onReorder(newCategories);

      // Invalidate cache to trigger a refetch
      await queryClient.invalidateQueries({ queryKey: ["/api/categories"] });

    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update category order",
        variant: "destructive"
      });
      // Reset to original order
      onReorder(categories);
    }
  };

  const handleNewRowToggle = async (id: number) => {
    const category = categories.find(c => c.id === id);
    if (!category) return;

    const newRow = !category.newRow;

    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          newRow,
          // Include all existing properties
          name: category.name,
          discordRoleId: category.discordRoleId,
          discordCategoryId: category.discordCategoryId,
          questions: category.questions,
          serviceSummary: category.serviceSummary,
          serviceImageUrl: category.serviceImageUrl,
          displayOrder: category.displayOrder
        })
      });

      if (!res.ok) throw new Error('Failed to update category');

      // Update local state
      const updatedCategories = categories.map(cat => 
        cat.id === id ? { ...cat, newRow } : cat
      );
      onReorder(updatedCategories);

      // Force refresh the categories
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update row setting",
        variant: "destructive"
      });
    }
  };

  const handleDeleteCategory = async (id: number) => {
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to delete category');

      // Update local state
      const updatedCategories = categories.filter(cat => cat.id !== id);
      onReorder(updatedCategories);

      // Show success message
      toast({
        title: "Success",
        description: "Category deleted successfully",
      });

      // Force refresh the categories
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete category",
        variant: "destructive"
      });
    }
  };

  // Group categories into rows based on newRow property
  const rows: Category[][] = [];
  let currentRow: Category[] = [];

  for (const category of categories) {
    if (category.newRow && currentRow.length > 0) {
      rows.push([...currentRow]);
      currentRow = [category];
    } else {
      currentRow.push(category);
      if (currentRow.length === 2) {
        rows.push([...currentRow]);
        currentRow = [];
      }
    }
  }

  if (currentRow.length > 0) {
    rows.push([...currentRow]);
  }

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <h3 className="text-sm font-medium mb-4">
        • Drag category names to reorder them
        <br />
        • Toggle "Start New Row" to control button layout
        <br />
        • Click the trash icon to delete a category
      </h3>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        modifiers={[restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-col gap-4">
          <SortableContext
            items={categories.map(cat => cat.id)}
            strategy={rectSortingStrategy}
          >
            <div className="flex flex-wrap gap-4 min-h-[100px] bg-white p-4 rounded-lg border-2 border-dashed border-gray-200">
              {categories.map(category => (
                <SortableItem
                  key={category.id}
                  id={category.id}
                  category={category}
                  onNewRowToggle={handleNewRowToggle}
                  onDeleteCategory={handleDeleteCategory}
                />
              ))}
            </div>
          </SortableContext>
        </div>
      </DndContext>

      <div className="mt-8 p-4 border rounded bg-white">
        <h4 className="text-sm font-medium mb-4">Telegram Preview</h4>
        <div className="space-y-2">
          {rows.map((row, rowIndex) => (
            <div key={rowIndex} className="flex gap-2">
              {row.map((category, index) => (
                <button key={index} className="flex-1 px-4 py-2 text-sm bg-blue-100 rounded text-center">
                  {category.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}