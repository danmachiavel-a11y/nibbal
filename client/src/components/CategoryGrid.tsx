import { useSortable, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  DndContext, 
  DragEndEvent, 
  MouseSensor, 
  TouchSensor, 
  useSensor, 
  useSensors,
  DragOverlay,
  pointerWithin,
  getFirstCollision
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import type { Category } from "@shared/schema";

interface SortableItemProps {
  id: number;
  category: Category;
}

function SortableItem({ id, category }: SortableItemProps) {
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
    cursor: 'grab',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="p-2"
    >
      <Card className="bg-white">
        <CardHeader className="p-3">
          <CardTitle className="text-sm font-medium">{category.name}</CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}

interface CategoryGridProps {
  categories: Category[];
  onReorder: (categories: Category[]) => void;
}

export function CategoryGrid({ categories, onReorder }: CategoryGridProps) {
  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor)
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = categories.findIndex(cat => cat.id === active.id);
      const newIndex = categories.findIndex(cat => cat.id === over.id);

      const newCategories = [...categories];
      const [removed] = newCategories.splice(oldIndex, 1);
      newCategories.splice(newIndex, 0, removed);

      onReorder(newCategories);
    }
  }

  // Group categories into rows based on their positions
  const rows = categories.reduce((acc, category, index) => {
    const rowIndex = Math.floor(index / (category.buttonsPerRow || 1));
    if (!acc[rowIndex]) acc[rowIndex] = [];
    acc[rowIndex].push(category);
    return acc;
  }, [] as Category[][]);

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <h3 className="text-sm font-medium mb-4">Drag categories horizontally to group them in rows. Each row can have 1-3 buttons.</h3>
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
            <div className="grid grid-cols-3 gap-4 min-h-[100px] bg-white p-4 rounded-lg border-2 border-dashed border-gray-200">
              {categories.map(category => (
                <SortableItem
                  key={category.id}
                  id={category.id}
                  category={category}
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
                <button key={index} className="px-4 py-2 text-sm bg-blue-100 rounded">
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