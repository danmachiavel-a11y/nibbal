import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Category } from "@shared/schema";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useState, useEffect } from 'react';
import { Folder, FolderOpen, Tag, Info } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { CategoryGrid } from "@/components/CategoryGrid";

function CategoryList({ categories }: { categories: Category[] }) {
  const submenus = categories.filter(cat => cat.isSubmenu);
  const rootCategories = categories.filter(cat => !cat.parentId && !cat.isSubmenu);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  const toggleAccordion = (value: string) => {
    setExpandedItems(current =>
      current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value]
    );
  };

  return (
    <div className="space-y-6">
      {/* Root Categories Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Tag className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Root Categories</h3>
          <span className="text-sm text-muted-foreground">
            ({rootCategories.length})
          </span>
        </div>
        <Accordion
          type="multiple"
          value={expandedItems}
          onValueChange={setExpandedItems}
          className="w-full space-y-2"
        >
          {rootCategories.map(category => (
            <AccordionItem
              key={category.id}
              value={category.id.toString()}
              className="border rounded-lg shadow-sm bg-card"
            >
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-3">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <span>{category.name}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-3">
                <div className="border-l-2 pl-4 ml-2 border-muted">
                  <CategoryEditor category={category} categories={categories} />
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      {/* Submenus Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Folder className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Submenus</h3>
          <span className="text-sm text-muted-foreground">
            ({submenus.length})
          </span>
        </div>
        <Accordion
          type="multiple"
          value={expandedItems}
          onValueChange={setExpandedItems}
          className="w-full space-y-2"
        >
          {submenus.map(submenu => (
            <AccordionItem
              key={submenu.id}
              value={submenu.id.toString()}
              className="border rounded-lg shadow-sm bg-card"
            >
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-3">
                  {expandedItems.includes(submenu.id.toString())
                    ? <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    : <Folder className="h-4 w-4 text-muted-foreground" />
                  }
                  <span>{submenu.name}</span>
                  <span className="text-sm text-muted-foreground ml-2">
                    ({categories.filter(cat => cat.parentId === submenu.id).length} categories)
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="border-l-2 ml-6 pl-4">
                <CategoryEditor category={submenu} categories={categories} />

                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Tag className="h-4 w-4" />
                    <h4 className="text-sm font-medium">Categories</h4>
                  </div>
                  <Accordion
                    type="multiple"
                    value={expandedItems}
                    onValueChange={setExpandedItems}
                    className="w-full space-y-2"
                  >
                    {categories
                      .filter(cat => cat.parentId === submenu.id)
                      .map(category => (
                        <AccordionItem
                          key={category.id}
                          value={`${category.id}-child`}
                          className="border rounded-lg shadow-sm bg-card"
                        >
                          <AccordionTrigger className="px-4 hover:no-underline">
                            <div className="flex items-center gap-3">
                              <Tag className="h-4 w-4 text-muted-foreground" />
                              <span>{category.name}</span>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-3">
                            <CategoryEditor category={category} categories={categories} />
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                  </Accordion>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}

function CategoryEditor({ category, categories }: { category: Category; categories: Category[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const form = useForm({
    defaultValues: {
      name: category.name,
      isSubmenu: category.isSubmenu,
      parentId: category.parentId,
      discordRoleId: category.discordRoleId || "",
      discordCategoryId: category.discordCategoryId || "",
      transcriptCategoryId: category.transcriptCategoryId || "",
      questions: category.questions?.join('\n') || "",
      serviceSummary: category.serviceSummary || "",
      serviceImageUrl: category.serviceImageUrl || "",
      displayOrder: category.displayOrder || 0,
      newRow: category.newRow || false,
      discordCategories: [],
      discordRoles: []
    }
  });

  useEffect(() => {
    const loadDiscordData = async () => {
      try {
        // Load categories
        const categoriesRes = await apiRequest("GET", "/api/discord/categories");
        if (!categoriesRes.ok) throw new Error("Failed to fetch Discord categories");
        const categories = await categoriesRes.json();
        form.setValue("discordCategories", categories);

        // Load roles
        const rolesRes = await apiRequest("GET", "/api/discord/roles");
        if (!rolesRes.ok) throw new Error("Failed to fetch Discord roles");
        const roles = await rolesRes.json();
        form.setValue("discordRoles", roles);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load Discord data",
          variant: "destructive"
        });
      }
    };
    loadDiscordData();
  }, []);

  const onSubmit = async (data: any) => {
    try {
      const questions = data.questions
        .split('\n')
        .filter((q: string) => q.trim())
        .map((q: string) => q.trim());

      const submitData = {
        name: data.name,
        discordRoleId: data.discordRoleId,
        discordCategoryId: data.discordCategoryId,
        transcriptCategoryId: data.transcriptCategoryId,
        questions,
        serviceSummary: data.serviceSummary,
        serviceImageUrl: data.serviceImageUrl,
        parentId: data.parentId,
        isSubmenu: data.isSubmenu,
        displayOrder: data.displayOrder,
        newRow: data.newRow
      };

      const res = await apiRequest("PATCH", `/api/categories/${category.id}`, submitData);
      if (!res.ok) throw new Error("Failed to update category");

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });

      toast({
        title: "Success",
        description: `Updated ${category.isSubmenu ? "submenu" : "category"}: ${data.name}`,
      });

    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update category",
        variant: "destructive"
      });
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="flex items-center gap-4 mb-4">
          <FormField
            control={form.control}
            name="displayOrder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display Order</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    onChange={(e) => field.onChange(parseInt(e.target.value))}
                    className="w-24"
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="newRow"
            render={({ field }) => (
              <FormItem className="flex items-center space-x-2">
                <FormControl>
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={field.onChange}
                    className="h-4 w-4"
                  />
                </FormControl>
                <FormLabel className="m-0">Start New Row</FormLabel>
              </FormItem>
            )}
          />
        </div>

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

        {!category.isSubmenu && (
          <FormField
            control={form.control}
            name="parentId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Parent Submenu</FormLabel>
                <FormDescription>
                  Choose which submenu this category belongs to
                </FormDescription>
                <FormControl>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                    value={field.value || ""}
                    onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                  >
                    <option value="">None (Root Level)</option>
                    {categories?.filter(cat => cat.isSubmenu && cat.id !== category.id).map(submenu => (
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

        {!category.isSubmenu && (
          <>
            <FormField
              control={form.control}
              name="discordRoleId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discord Role</FormLabel>
                  <FormDescription>
                    Select a Discord role
                  </FormDescription>
                  <div className="flex space-x-2">
                    <FormControl>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2"
                        value={field.value || ''}
                        onChange={(e) => field.onChange(e.target.value)}
                      >
                        <option value="">Select a role</option>
                        {form.watch("discordRoles")?.map((role: any) => (
                          <option
                            key={role.id}
                            value={role.id}
                            style={{ color: role.color !== '#000000' ? role.color : 'inherit' }}
                          >
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const res = await apiRequest("GET", "/api/discord/roles");
                          if (!res.ok) throw new Error("Failed to fetch Discord roles");
                          const roles = await res.json();
                          form.setValue("discordRoles", roles);
                        } catch (error) {
                          toast({
                            title: "Error",
                            description: "Failed to load Discord roles",
                            variant: "destructive"
                          });
                        }
                      }}
                    >
                      Refresh Roles
                    </Button>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="discordCategoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discord Category</FormLabel>
                  <FormDescription>
                    Select a Discord category
                  </FormDescription>
                  <div className="flex space-x-2">
                    <FormControl>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2"
                        value={field.value || ''}
                        onChange={(e) => field.onChange(e.target.value)}
                      >
                        <option value="">Select a category</option>
                        {form.watch("discordCategories")?.map((category: any) => (
                          <option
                            key={category.id}
                            value={category.id}
                          >
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const res = await apiRequest("GET", "/api/discord/categories");
                          if (!res.ok) throw new Error("Failed to fetch Discord categories");
                          const categories = await res.json();
                          form.setValue("discordCategories", categories);
                        } catch (error) {
                          toast({
                            title: "Error",
                            description: "Failed to load Discord categories",
                            variant: "destructive"
                          });
                        }
                      }}
                    >
                      Refresh Categories
                    </Button>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="transcriptCategoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discord Transcript Category</FormLabel>
                  <FormDescription>
                    The category where closed tickets will be moved
                  </FormDescription>
                  <div className="flex space-x-2">
                    <FormControl>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2"
                        value={field.value || ''}
                        onChange={(e) => field.onChange(e.target.value)}
                      >
                        <option value="">Select a category</option>
                        {form.watch("discordCategories")?.map((category: any) => (
                          <option
                            key={category.id}
                            value={category.id}
                          >
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="questions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Questions</FormLabel>
                  <FormDescription>
                    Enter each question on a new line
                  </FormDescription>
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
          </>
        )}

        <div className="flex justify-end space-x-2">
          <Button type="submit">Save Changes</Button>
        </div>
      </form>
    </Form>
  );
}

function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("existing");

  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  const categoryForm = useForm({
    defaultValues: {
      isSubmenu: false,
      name: "",
      parentId: null,
      discordRoleId: "",
      discordCategoryId: "",
      transcriptCategoryId: "",
      questions: "",
      serviceSummary: "",
      serviceImageUrl: "",
      discordCategories: [],
      discordRoles: []
    }
  });

  const botConfigForm = useForm({
    defaultValues: {
      telegramToken: "",
      discordToken: "",
      welcomeMessage: "",
      welcomeImageUrl: ""
    }
  });

  useEffect(() => {
    const loadBotConfig = async () => {
      try {
        const res = await apiRequest("GET", "/api/bot-config");
        if (!res.ok) throw new Error("Failed to fetch bot configuration");
        const config = await res.json();

        // Set form values with the loaded configuration
        botConfigForm.setValue("telegramToken", config.telegramToken || "");
        botConfigForm.setValue("discordToken", config.discordToken || "");
        botConfigForm.setValue("welcomeMessage", config.welcomeMessage || "");
        botConfigForm.setValue("welcomeImageUrl", config.welcomeImageUrl || "");
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load bot configuration",
          variant: "destructive"
        });
      }
    };
    loadBotConfig();
  }, []);

  const onBotConfigSubmit = async (data: any) => {
    try {
      // Send all bot configuration fields
      const res = await apiRequest("PATCH", "/api/bot-config", {
        telegramToken: data.telegramToken,
        discordToken: data.discordToken,
        welcomeMessage: data.welcomeMessage,
        welcomeImageUrl: data.welcomeImageUrl
      });

      if (!res.ok) throw new Error("Failed to update bot configuration");

      toast({ 
        title: "Success", 
        description: "Bot configuration saved successfully!" 
      });
    } catch (error) {
      toast({ 
        title: "Error", 
        description: "Failed to save bot configuration", 
        variant: "destructive" 
      });
    }
  };


  useEffect(() => {
    const loadDiscordData = async () => {
      try {
        // Load categories
        const categoriesRes = await apiRequest("GET", "/api/discord/categories");
        if (!categoriesRes.ok) throw new Error("Failed to fetch Discord categories");
        const categories = await categoriesRes.json();
        categoryForm.setValue("discordCategories", categories);

        // Load roles
        const rolesRes = await apiRequest("GET", "/api/discord/roles");
        if (!rolesRes.ok) throw new Error("Failed to fetch Discord roles");
        const roles = await rolesRes.json();
        categoryForm.setValue("discordRoles", roles);
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to load Discord data",
          variant: "destructive"
        });
      }
    };
    loadDiscordData();
  }, []);

  const onSubmit = async (data: any) => {
    try {
      const questions = data.questions
        .split('\n')
        .filter((q: string) => q.trim())
        .map((q: string) => q.trim());

      const submitData = {
        name: data.name,
        isSubmenu: data.isSubmenu,
        discordRoleId: data.discordRoleId,
        discordCategoryId: data.discordCategoryId,
        transcriptCategoryId: data.transcriptCategoryId,
        questions,
        serviceSummary: data.serviceSummary,
        serviceImageUrl: data.serviceImageUrl,
        parentId: data.parentId
      };

      const res = await apiRequest("POST", "/api/categories", submitData);
      if (!res.ok) throw new Error("Failed to create category");

      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });

      toast({
        title: "Success",
        description: `Created new ${data.isSubmenu ? "submenu" : "category"}: ${data.name}`,
      });

      // Reset form
      categoryForm.reset();

    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create category",
        variant: "destructive"
      });
    }
  };

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>Categories & Submenus</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList>
              <TabsTrigger value="existing">Existing Categories</TabsTrigger>
              <TabsTrigger value="new">Create New</TabsTrigger>
              <TabsTrigger value="bot-config">Bot Configuration</TabsTrigger>
            </TabsList>

            <TabsContent value="existing">
              {categories ? (
                <CategoryGrid 
                  categories={categories} 
                  onReorder={(updatedCategories) => {
                    queryClient.setQueryData(["/api/categories"], updatedCategories);
                  }} 
                />
              ) : (
                <div>Loading categories...</div>
              )}
            </TabsContent>

            <TabsContent value="new">
              <Card>
                <CardHeader>
                  <CardTitle>Create New Menu Item</CardTitle>
                </CardHeader>
                <CardContent>
                  <Form {...categoryForm}>
                    <form onSubmit={categoryForm.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={categoryForm.control}
                        name="isSubmenu"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Type</FormLabel>
                            <FormDescription>
                              Choose whether this is a submenu (like "Food") or a category (like "Grubhub")
                            </FormDescription>
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
                                <FormDescription>
                                  Choose which submenu this category belongs to
                                </FormDescription>
                                <FormControl>
                                  <select
                                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                                    value={field.value || ""}
                                    onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                                  >
                                    <option value="">None (Root Level)</option>
                                    {categories?.filter(cat => cat.isSubmenu).map(submenu => (
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
                                <FormLabel>Discord Role</FormLabel>
                                <FormDescription>
                                  Select a Discord role
                                </FormDescription>
                                <div className="flex space-x-2">
                                  <FormControl>
                                    <select
                                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                                      value={field.value || ''}
                                      onChange={(e) => field.onChange(e.target.value)}
                                    >
                                      <option value="">Select a role</option>
                                      {categoryForm.watch("discordRoles")?.map((role: any) => (
                                        <option
                                          key={role.id}
                                          value={role.id}
                                          style={{ color: role.color !== '#000000' ? role.color : 'inherit' }}
                                        >
                                          {role.name}
                                        </option>
                                      ))}
                                    </select>
                                  </FormControl>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={async () => {
                                      try {
                                        const res = await apiRequest("GET", "/api/discord/roles");
                                        if (!res.ok) throw new Error("Failed to fetch Discord roles");
                                        const roles = await res.json();
                                        categoryForm.setValue("discordRoles", roles);
                                      } catch (error) {
                                        toast({
                                          title: "Error",
                                          description: "Failed to load Discord roles",
                                          variant: "destructive"
                                        });
                                      }
                                    }}
                                  >
                                    Refresh Roles
                                  </Button>
                                </div>
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={categoryForm.control}
                            name="discordCategoryId"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Discord Category</FormLabel>
                                <FormDescription>
                                  Select a Discord category
                                </FormDescription>
                                <div className="flex space-x-2">
                                  <FormControl>
                                    <select
                                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                                      value={field.value || ''}
                                      onChange={(e) => field.onChange(e.target.value)}
                                    >
                                      <option value="">Select a category</option>
                                      {categoryForm.watch("discordCategories")?.map((category: any) => (
                                        <option
                                          key={category.id}
                                          value={category.id}
                                        >
                                          {category.name}
                                        </option>
                                      ))}
                                    </select>
                                  </FormControl>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    onClick={async () => {
                                      try {
                                        const res = await apiRequest("GET", "/api/discord/categories");
                                        if (!res.ok) throw new Error("Failed to fetch Discord categories");
                                        const categories = await res.json();
                                        categoryForm.setValue("discordCategories", categories);
                                      } catch (error) {
                                        toast({
                                          title: "Error",
                                          description: "Failed to load Discord categories",
                                          variant: "destructive"
                                        });
                                      }
                                    }}
                                  >
                                    Refresh Categories
                                  </Button>
                                </div>
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={categoryForm.control}
                            name="transcriptCategoryId"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Discord Transcript Category</FormLabel>
                                <FormDescription>
                                  The category where closed tickets will be moved
                                </FormDescription>
                                <div className="flex space-x-2">
                                  <FormControl>
                                    <select
                                      className="w-full rounded-md border border-input bg-background px-3 py-2"
                                      value={field.value || ''}
                                      onChange={(e) => field.onChange(e.target.value)}
                                    >
                                      <option value="">Select a category</option>
                                      {categoryForm.watch("discordCategories")?.map((category: any) => (
                                        <option
                                          key={category.id}
                                          value={category.id}
                                        >
                                          {category.name}
                                        </option>
                                      ))}
                                    </select>
                                  </FormControl>
                                </div>
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={categoryForm.control}
                            name="questions"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Questions</FormLabel>
                                <FormDescription>
                                  Enter each question on a new line
                                </FormDescription>
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
                        </>
                      )}

                      <Button type="submit">Create {categoryForm.watch("isSubmenu") ? "Submenu" : "Category"}</Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="bot-config">
              <Card>
                <CardHeader>
                  <CardTitle>Bot Configuration</CardTitle>
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
                              Enter the welcome message shown when users start the bot.
                              You can use Markdown formatting:
                              - **text** for bold
                              - __text__ for italic
                              - ```text``` for code blocks
                            </FormDescription>
                            <FormControl>
                              <Textarea {...field} rows={3} />
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

                      <FormField
                        control={botConfigForm.control}
                        name="telegramToken"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center gap-2">
                              <FormLabel>Telegram Bot Token</FormLabel>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger>
                                    <Info className="h-4 w-4 text-muted-foreground" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>During development/testing, the bot may show as "not connected"</p>
                                    <p>because Telegram only allows one active connection per token.</p>
                                    <p>This is normal and the bot will still work inproduction.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                            <FormDescription>
                              Enter your Telegram bot token. You can get this from @BotFather on Telegram.
                            </FormDescription>
                            <div className="flex space-x-2">
                              <FormControl>
                                <Input type="password" {...field} />
                              </FormControl>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={async () => {
                                  try {
                                    const res = await apiRequest("GET", "/api/bot/telegram/status");
                                    if (!res.ok) throw new Error("Failed to check Telegram bot status");
                                    const status = await res.json();
                                    toast({
                                      title: "Telegram Bot Status",
                                      description: status.connected
                                        ? "Connected and ready"
                                        : "Not connected - This is normal during testing. The bot will work in production.",
                                      variant: status.connected ? "default" : "destructive"
                                    });
                                  } catch (error) {
                                    toast({
                                      title: "Error",
                                      description: "Failed to check Telegram bot status",
                                      variant: "destructive"
                                    });
                                  }
                                }}
                              >
                                Check Status
                              </Button>
                            </div>
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={botConfigForm.control}
                        name="discordToken"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Discord Bot Token</FormLabel>
                            <FormDescription>
                              Enter your Discord bot token. You can get this from the Discord Developer Portal.
                            </FormDescription>
                            <div className="flex space-x-2">
                              <FormControl>
                                <Input type="password" {...field} />
                              </FormControl>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={async () => {
                                  try {
                                    const res = await apiRequest("GET", "/api/bot/discord/status");
                                    if (!res.ok) throw new Error("Failed to check Discord bot status");
                                    const status = await res.json();
                                    toast({
                                      title: "Discord Bot Status",
                                      description: status.connected ? "Connected" : "Not Connected",
                                      variant: status.connected ? "default" : "destructive"
                                    });
                                  } catch (error) {
                                    toast({
                                      title: "Error",
                                      description: "Failed to check Discord bot status",
                                      variant: "destructive"
                                    });
                                  }
                                }}
                              >
                                Check Status
                              </Button>
                            </div>
                          </FormItem>
                        )}
                      />

                      <div className="flex justify-end space-x-2">
                        <Button type="submit" size="sm">
                          Save Bot Configuration
                        </Button>
                      </div>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsPage;