import { useSortable, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface SortableItemProps {
  id: number;
  category: Category;
  onNewRowToggle: (id: number, newRow: boolean) => void;
}

function SortableItem({ id, category, onNewRowToggle }: SortableItemProps) {
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
          <CardTitle className="text-sm font-medium cursor-grab">{category.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button 
            variant={category.newRow ? "default" : "outline"}
            onClick={() => onNewRowToggle(id, !category.newRow)}
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

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = categories.findIndex(cat => cat.id === active.id);
      const newIndex = categories.findIndex(cat => cat.id === over.id);

      // Create new array with updated order
      const newCategories = [...categories];
      const [removed] = newCategories.splice(oldIndex, 1);
      newCategories.splice(newIndex, 0, removed);

      // Update local state first
      onReorder(newCategories);

      // Then persist to database
      try {
        for (let i = 0; i < newCategories.length; i++) {
          const category = newCategories[i];
          const res = await apiRequest("PATCH", `/api/categories/${category.id}`, {
            displayOrder: i
          });
          if (!res.ok) throw new Error("Failed to update category order");
        }

        // Refresh categories from server
        queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to save category order",
          variant: "destructive"
        });
      }
    }
  }

  const handleNewRowToggle = async (id: number, newRow: boolean) => {
    // Find the category to update
    const categoryToUpdate = categories.find(c => c.id === id);
    if (!categoryToUpdate) return;

    // Update local state first
    const updatedCategories = categories.map(cat => 
      cat.id === id ? { ...cat, newRow } : cat
    );
    onReorder(updatedCategories);

    // Then persist to database
    try {
      const res = await apiRequest("PATCH", `/api/categories/${id}`, { 
        newRow 
      });

      if (!res.ok) {
        throw new Error("Failed to update category");
      }

      // Refresh categories from server
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update row setting",
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
        • Click "Start New Row" button to control button layout
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