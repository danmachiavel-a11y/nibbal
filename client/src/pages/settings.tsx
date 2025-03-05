import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormDescription as FormDescriptionUI } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Category, BotConfig, Question } from "@shared/schema";
import { CategoryGrid } from "@/components/CategoryGrid";

const botConfigSchema = z.object({
  welcomeMessage: z.string(),
  welcomeImageUrl: z.string().nullable(),
});

const categorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  isSubmenu: z.boolean().optional(),
  discordRoleId: z.string().optional(),
  discordCategoryId: z.string().optional(),
  questions: z.string(),
  serviceSummary: z.string().optional(),
  serviceImageUrl: z.string().nullable().optional(),
  parentId: z.number().nullable().optional(),
});

const CustomFormDescription = () => (
  <div className="text-sm text-muted-foreground">
    Enter each question on a new line. For button questions, add button options after the question using {'>>'}:
    <pre className="mt-2 p-2 bg-muted rounded-md">
      What is your preferred service level?
      {'>>'}Basic{'>>'}Standard{'>>'}Premium
    </pre>
  </div>
);


export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: botConfig } = useQuery<BotConfig>({
    queryKey: ["/api/bot-config"]
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  // Separate root menus (submenus) and their child categories
  const submenus = categories?.filter(cat => cat.isSubmenu) || [];
  const rootCategories = categories?.filter(cat => !cat.parentId && !cat.isSubmenu) || [];

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
      isSubmenu: false,
      parentId: null,
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
      // Parse questions and button options
      const questions: Question[] = data.questions.split('\n')
        .filter(q => q.trim())
        .map(q => {
          const parts = q.split('>>');
          return {
            text: parts[0].trim(),
            buttons: parts.length > 1 ? parts.slice(1) : undefined
          };
        });

      const submitData = {
        ...data,
        questions
      };

      const res = await apiRequest("POST", "/api/categories", submitData);
      if (!res.ok) throw new Error("Failed to create category");

      toast({
        title: "Success",
        description: `${data.isSubmenu ? "Submenu" : "Category"} created successfully`
      });

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
      categoryForm.reset();
    } catch (error) {
      console.error("Error creating category:", error);
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
                      <FormDescriptionUI>
                        This message will be shown when users first start the bot.
                        Use new lines to format your message.
                      </FormDescriptionUI>
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
                      <FormDescriptionUI>
                        Optional: URL of an image to show with the welcome message
                      </FormDescriptionUI>
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
            <CardTitle>Create New Menu Item</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...categoryForm}>
              <form onSubmit={categoryForm.handleSubmit(onCategorySubmit)} className="space-y-4">
                <FormField
                  control={categoryForm.control}
                  name="isSubmenu"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <FormDescriptionUI>
                        Choose whether this is a submenu (like "Food") or a category (like "Grubhub")
                      </FormDescriptionUI>
                      <FormControl>
                        <Tabs
                          value={field.value ? "submenu" : "category"}
                          onValueChange={(value) => field.onChange(value === "submenu")}
                          className="w-full"
                        >
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="category">Category</TabsTrigger>
                            <TabsTrigger value="submenu">Submenu</TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={categoryForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {!categoryForm.watch("isSubmenu") && (
                  <>
                    <FormField
                      control={categoryForm.control}
                      name="parentId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Parent Submenu</FormLabel>
                          <FormDescriptionUI>
                            Choose which submenu this category belongs to
                          </FormDescriptionUI>
                          <FormControl>
                            <select
                              className="w-full rounded-md border border-input bg-background px-3 py-2"
                              value={field.value || ""}
                              onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                            >
                              <option value="">None (Root Level)</option>
                              {submenus.map(submenu => (
                                <option key={submenu.id} value={submenu.id}>
                                  {submenu.name}
                                </option>
                              ))}
                            </select>
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
                          <FormLabel>Questions</FormLabel>
                          <FormDescriptionUI>
                            <CustomFormDescription />
                          </FormDescriptionUI>
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
                          <FormDescriptionUI>
                            Description of this service shown when users select it.
                            Use new lines to format your message.
                          </FormDescriptionUI>
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
                          <FormDescriptionUI>
                            Optional: URL of an image to show with the service description
                          </FormDescriptionUI>
                          <FormControl>
                            <Input {...field} value={field.value || ''} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </>
                )}

                <Button type="submit">
                  Create {categoryForm.watch("isSubmenu") ? "Submenu" : "Category"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {categories && categories.length > 0 && (
          <Tabs defaultValue="root" className="w-full">
            <TabsList>
              <TabsTrigger value="root">Root Menu</TabsTrigger>
              {submenus.map(submenu => (
                <TabsTrigger key={submenu.id} value={submenu.id.toString()}>
                  {submenu.name}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="root">
              <Card>
                <CardHeader>
                  <CardTitle>Root Menu Layout</CardTitle>
                </CardHeader>
                <CardContent>
                  <CategoryGrid
                    categories={rootCategories}
                    onReorder={async (newCategories) => {
                      try {
                        // Update all categories with new display orders
                        for (let i = 0; i < newCategories.length; i++) {
                          const res = await apiRequest("PATCH", `/api/categories/${newCategories[i].id}`, {
                            displayOrder: i
                          });
                          if (!res.ok) throw new Error("Failed to update category order");
                        }

                        queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
                      } catch (error) {
                        toast({
                          title: "Error",
                          description: "Failed to update category order",
                          variant: "destructive"
                        });
                      }
                    }}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {submenus.map(submenu => (
              <TabsContent key={submenu.id} value={submenu.id.toString()}>
                <Card>
                  <CardHeader>
                    <CardTitle>{submenu.name} Layout</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CategoryGrid
                      categories={categories.filter(cat => cat.parentId === submenu.id)}
                      onReorder={async (newCategories) => {
                        try {
                          // Update all categories with new display orders
                          for (let i = 0; i < newCategories.length; i++) {
                            const res = await apiRequest("PATCH", `/api/categories/${newCategories[i].id}`, {
                              displayOrder: i
                            });
                            if (!res.ok) throw new Error("Failed to update category order");
                          }

                          queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
                        } catch (error) {
                          toast({
                            title: "Error",
                            description: "Failed to update category order",
                            variant: "destructive"
                          });
                        }
                      }}
                    />
                  </CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
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

export function CategoryEditor({ category }: { category: Category }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: category.name,
      discordRoleId: category.discordRoleId,
      discordCategoryId: category.discordCategoryId,
      questions: category.questions.map(q => {
        if (q.buttons?.length) {
          return `${q.text}\n${q.buttons.map(b => `>>${b}`).join('')}`;
        }
        return q.text;
      }).join('\n'),
      serviceSummary: category.serviceSummary || "Our team is ready to assist you!",
      serviceImageUrl: category.serviceImageUrl || "",
      isSubmenu: category.isSubmenu || false,
      parentId: category.parentId || null,
    }
  });

  async function onSubmit(data: z.infer<typeof categorySchema>) {
    try {
      // Parse questions and button options
      const questions: Question[] = data.questions.split('\n')
        .filter(q => q.trim())
        .map(q => {
          const parts = q.split('>>');
          return {
            text: parts[0].trim(),
            buttons: parts.length > 1 ? parts.slice(1).map(b => b.trim()) : undefined
          };
        });

      const submitData = {
        ...data,
        questions,
        displayOrder: category.displayOrder, 
        newRow: category.newRow 
      };

      const res = await apiRequest("PATCH", `/api/categories/${category.id}`, submitData);
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
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isSubmenu"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <FormControl>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                      value={field.value ? "submenu" : "category"}
                      onChange={(e) => field.onChange(e.target.value === "submenu")}
                      disabled={category.isSubmenu} 
                    >
                      <option value="category">Category</option>
                      <option value="submenu">Submenu</option>
                    </select>
                  </FormControl>
                </FormItem>
              )}
            />

            {!form.watch("isSubmenu") && (
              <FormField
                control={form.control}
                name="parentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Parent Submenu</FormLabel>
                    <FormDescriptionUI>
                      Choose which submenu this category belongs to
                    </FormDescriptionUI>
                    <FormControl>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                      >
                        <option value="">None (Root Level)</option>
                        {submenus.map(submenu => (
                          <option key={submenu.id} value={submenu.id}>
                            {submenu.name}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

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
                  <FormLabel>Questions</FormLabel>
                  <FormDescriptionUI>
                    <CustomFormDescription />
                  </FormDescriptionUI>
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
                  <FormDescriptionUI>
                    Description of this service shown when users select it.
                    Use new lines to format your message.
                  </FormDescriptionUI>
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
                  <FormDescriptionUI>
                    Optional: URL of an image to show with the service description
                  </FormDescriptionUI>
                  <FormControl>
                    <Input {...field} value={field.value || ''} />
                  </FormControl>
                </FormItem>
              )}
            />

            <Button type="submit">Update {category.isSubmenu ? "Submenu" : "Category"}</Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}