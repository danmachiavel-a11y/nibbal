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
import type { Category, BotConfig } from "@shared/schema";
import { CategoryGrid } from "@/components/CategoryGrid";

const botConfigSchema = z.object({
  welcomeMessage: z.string(),
  welcomeImageUrl: z.string().nullable(),
});

const categorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  discordRoleId: z.string().min(1, "Discord Role ID is required"),
  discordCategoryId: z.string().min(1, "Discord Category ID is required"),
  questions: z.string().transform(str => str.split("\n").filter(q => q.trim())),
  serviceSummary: z.string().optional(),
  serviceImageUrl: z.string().nullable().optional(),
});

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: botConfig } = useQuery<BotConfig>({
    queryKey: ["/api/bot-config"]
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  const botConfigForm = useForm({
    resolver: zodResolver(botConfigSchema),
    defaultValues: {
      welcomeMessage: botConfig?.welcomeMessage || "Welcome to the support bot! Please select a service:",
      welcomeImageUrl: botConfig?.welcomeImageUrl || "",
    }
  });

  const categoryForm = useForm({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: "",
      discordRoleId: "",
      discordCategoryId: "",
      questions: "",
      serviceSummary: "Our team is ready to assist you!",
      serviceImageUrl: "",
    }
  });

  async function onBotConfigSubmit(data: z.infer<typeof botConfigSchema>) {
    try {
      const res = await apiRequest("PATCH", "/api/bot-config", data);
      if (!res.ok) throw new Error("Failed to update bot config");

      toast({
        title: "Success",
        description: "Bot configuration updated successfully"
      });

      queryClient.invalidateQueries({ queryKey: ["/api/bot-config"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update bot configuration",
        variant: "destructive"
      });
    }
  }

  async function onCategorySubmit(data: z.infer<typeof categorySchema>) {
    try {
      const res = await apiRequest("POST", "/api/categories", data);
      if (!res.ok) throw new Error("Failed to create category");

      toast({
        title: "Success",
        description: "Category created successfully"
      });

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
      categoryForm.reset();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create category",
        variant: "destructive"
      });
    }
  }

  const handleReorder = async (reorderedCategories: Category[]) => {
    for (let i = 0; i < reorderedCategories.length; i++) {
      const category = reorderedCategories[i];
      try {
        await apiRequest("PATCH", `/api/categories/${category.id}`, {
          displayOrder: i
        });
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update category order",
          variant: "destructive"
        });
        return;
      }
    }

    queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    toast({
      title: "Success",
      description: "Category order updated"
    });
  };

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
            <CardTitle>Bot Welcome Message</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...botConfigForm}>
              <form onSubmit={botConfigForm.handleSubmit(onBotConfigSubmit)} className="space-y-4">
                <FormField
                  control={botConfigForm.control}
                  name="welcomeMessage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Welcome Message</FormLabel>
                      <FormDescription>
                        This message will be shown when users first start the bot.
                        Use new lines to format your message.
                      </FormDescription>
                      <FormControl>
                        <Textarea {...field} rows={5} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={botConfigForm.control}
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

                <Button type="submit">Update Welcome Message</Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create New Category</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...categoryForm}>
              <form onSubmit={categoryForm.handleSubmit(onCategorySubmit)} className="space-y-4">
                <FormField
                  control={categoryForm.control}
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
                  control={categoryForm.control}
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
                  control={categoryForm.control}
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
                  control={categoryForm.control}
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
                  control={categoryForm.control}
                  name="serviceSummary"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service Summary</FormLabel>
                      <FormDescription>
                        Description of this service shown when users select it.
                        Use new lines to format your message.
                      </FormDescription>
                      <FormControl>
                        <Textarea {...field} rows={5} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={categoryForm.control}
                  name="serviceImageUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Service Image URL</FormLabel>
                      <FormDescription>
                        Optional: URL of an image to show with the service description
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
              <CardTitle>Category Layout</CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryGrid
                categories={categories}
                onReorder={handleReorder}
              />
            </CardContent>
          </Card>
        )}
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
      serviceSummary: category.serviceSummary || "Our team is ready to assist you!",
      serviceImageUrl: category.serviceImageUrl || "",
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

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update category",
        variant: "destructive"
      });
    }
  }

  async function onDelete() {
    if (!confirm(`Are you sure you want to delete ${category.name}?`)) return;

    try {
      const res = await apiRequest("DELETE", `/api/categories/${category.id}`, undefined);
      if (!res.ok) throw new Error("Failed to delete category");

      toast({
        title: "Success",
        description: "Category deleted successfully"
      });

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete category",
        variant: "destructive"
      });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Edit {category.name}</CardTitle>
        <Button variant="destructive" onClick={onDelete}>Delete</Button>
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
              name="serviceSummary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Service Summary</FormLabel>
                  <FormDescription>
                    Description of this service shown when users select it.
                    Use new lines to format your message.
                  </FormDescription>
                  <FormControl>
                    <Textarea {...field} rows={5} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="serviceImageUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Service Image URL</FormLabel>
                  <FormDescription>
                    Optional: URL of an image to show with the service description
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