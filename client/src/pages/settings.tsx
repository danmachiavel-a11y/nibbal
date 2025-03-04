import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormDescription } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Category } from "@shared/schema";

const categorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  discordRoleId: z.string().min(1, "Discord Role ID is required"),
  discordCategoryId: z.string().min(1, "Discord Category ID is required"),
  questions: z.string().transform(str => str.split("\n").filter(q => q.trim())),
  welcomeMessage: z.string().optional(),
  welcomeImageUrl: z.string().nullable().optional(),
});

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  const form = useForm({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: "",
      discordRoleId: "",
      discordCategoryId: "",
      questions: "",
      welcomeMessage: "Select a category:",
      welcomeImageUrl: "",
    }
  });

  async function onSubmit(data: z.infer<typeof categorySchema>) {
    try {
      const res = await apiRequest("POST", "/api/categories", data);
      if (!res.ok) throw new Error("Failed to create category");

      toast({
        title: "Success",
        description: "Category created successfully"
      });

      // Refresh categories list
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
      form.reset();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create category",
        variant: "destructive"
      });
    }
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6">
        <Link href="/">
          <Button variant="ghost">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Create New Category</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="discordRoleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discord Role ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="discordCategoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Discord Category ID</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="questions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Questions (one per line)</FormLabel>
                      <FormControl>
                        <Textarea {...field} rows={5} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="welcomeMessage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Welcome Message</FormLabel>
                      <FormDescription>
                        This message will be shown when users start the bot
                      </FormDescription>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="welcomeImageUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Welcome Image URL</FormLabel>
                      <FormDescription>
                        Optional: URL of an image to show with the welcome message
                      </FormDescription>
                      <FormControl>
                        <Input {...field} value={field.value || ''} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <Button type="submit">Create Category</Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {categories && categories.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Existing Categories</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {categories.map(category => (
                  <CategoryEditor key={category.id} category={category} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function CategoryEditor({ category }: { category: Category }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: category.name,
      discordRoleId: category.discordRoleId,
      discordCategoryId: category.discordCategoryId,
      questions: category.questions.join("\n"),
      welcomeMessage: category.welcomeMessage || "Select a category:",
      welcomeImageUrl: category.welcomeImageUrl || "",
    }
  });

  async function onSubmit(data: z.infer<typeof categorySchema>) {
    try {
      const res = await apiRequest("PATCH", `/api/categories/${category.id}`, data);
      if (!res.ok) throw new Error("Failed to update category");

      toast({
        title: "Success",
        description: "Category updated successfully"
      });

      // Refresh categories list
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update category",
        variant: "destructive"
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit {category.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="discordRoleId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discord Role ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="discordCategoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discord Category ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="questions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Questions (one per line)</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={5} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="welcomeMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Welcome Message</FormLabel>
                  <FormDescription>
                    This message will be shown when users start the bot
                  </FormDescription>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="welcomeImageUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Welcome Image URL</FormLabel>
                  <FormDescription>
                    Optional: URL of an image to show with the welcome message
                  </FormDescription>
                  <FormControl>
                    <Input {...field} value={field.value || ''} />
                  </FormControl>
                </FormItem>
              )}
            />

            <Button type="submit">Update Category</Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}