import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import type { Category } from "@shared/schema";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Trash2 } from "lucide-react";

interface CategoryGridProps {
  categories: Category[];
  onReorder: (categories: Category[]) => void;
}

export function CategoryGrid({ categories, onReorder }: CategoryGridProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDeleteCategory = async (id: number) => {
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to delete category');

      const updatedCategories = categories.filter(cat => cat.id !== id);
      onReorder(updatedCategories);

      toast({
        title: "Success",
        description: "Category deleted successfully",
      });

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete category",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {categories.map(category => (
          <Card key={category.id} className="p-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-medium">{category.name}</h3>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="destructive"
                    size="sm"
                    className="flex items-center gap-2"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Category</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete "{category.name}"? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction 
                      onClick={() => handleDeleteCategory(category.id)}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}