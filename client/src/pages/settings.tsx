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

// CategoryList component definition (moved from a separate file)
function CategoryList({ categories }: { categories: Category[] }) {
  const submenus = categories.filter(cat => cat.isSubmenu);
  const rootCategories = categories.filter(cat => !cat.parentId && !cat.isSubmenu);

  return (
    <div className="space-y-4">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">Root Categories</h3>
        <Accordion type="multiple" className="w-full">
          {rootCategories.map(category => (
            <AccordionItem key={category.id} value={category.id.toString()}>
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <span>{category.name}</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <CategoryEditor category={category} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-2">Submenus</h3>
        <Accordion type="multiple" className="w-full">
          {submenus.map(submenu => (
            <AccordionItem key={submenu.id} value={submenu.id.toString()}>
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <span>{submenu.name}</span>
                  <span className="text-sm text-muted-foreground">
                    ({categories.filter(cat => cat.parentId === submenu.id).length} categories)
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="pl-4 border-l-2 border-border">
                  <CategoryEditor category={submenu} />

                  <div className="mt-4">
                    <h4 className="text-sm font-medium mb-2">Submenu Categories</h4>
                    <Accordion type="multiple" className="w-full">
                      {categories
                        .filter(cat => cat.parentId === submenu.id)
                        .map(category => (
                          <AccordionItem key={category.id} value={category.id.toString()}>
                            <AccordionTrigger className="hover:no-underline">
                              {category.name}
                            </AccordionTrigger>
                            <AccordionContent>
                              <CategoryEditor category={category} />
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                    </Accordion>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  );
}

// Placeholder for CategoryEditor component -  needs to be defined elsewhere
function CategoryEditor({category}: {category:Category}) {
    return <div>Edit Category: {category.name}</div>
}

export default function Settings() {
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
            </TabsList>

            <TabsContent value="existing">
              {categories && <CategoryList categories={categories} />}
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
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}