import { useEffect } from 'react';
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Category } from "@shared/schema";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Info, RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export async function refreshRoles(form: any, toast: any) {
  try {
    const res = await apiRequest("GET", "/api/discord/roles");
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Failed to fetch Discord roles: ${errorData.message || res.statusText}`);
    }
    const roles = await res.json();
    form.setValue("discordRoles", roles);
  } catch (error: any) {
    toast({
      title: "Error",
      description: `Failed to load Discord roles: ${error.message}`,
      variant: "destructive"
    });
  }
}

export async function refreshCategories(form: any, toast: any) {
  try {
    const res = await apiRequest("GET", "/api/discord/categories");
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Failed to fetch Discord categories: ${errorData.message || res.statusText}`);
    }
    const categories = await res.json();
    form.setValue("discordCategories", categories);
  } catch (error: any) {
    toast({
      title: "Error",
      description: `Failed to load Discord categories: ${error.message}`,
      variant: "destructive"
    });
  }
}

export function CategoryEditor({ category, categories }: { category: Category; categories: Category[] }) {
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
      questions: Array.isArray(category.questions) ? category.questions.join('\n') : "",
      serviceSummary: category.serviceSummary || "",
      serviceImageUrl: category.serviceImageUrl || "",
      displayOrder: category.displayOrder || 0,
      newRow: category.newRow || false,
      isClosed: category.isClosed || false,
      discordCategories: [],
      discordRoles: []
    }
  });

  // Load Discord roles and categories
  useEffect(() => {
    const loadDiscordData = async () => {
      await Promise.all([
        refreshRoles(form, toast),
        refreshCategories(form, toast)
      ]);
    };
    
    loadDiscordData();
  }, []);

  const onSubmit = async (data: any) => {
    try {
      // Format questions as an array
      const questions = data.questions
        .split('\n')
        .filter((q: string) => q.trim())
        .map((q: string) => q.trim());

      // Prepare data for API
      const submitData = {
        name: data.name,
        isSubmenu: data.isSubmenu,
        parentId: data.parentId,
        discordRoleId: data.discordRoleId,
        discordCategoryId: data.discordCategoryId,
        transcriptCategoryId: data.transcriptCategoryId,
        questions,
        serviceSummary: data.serviceSummary,
        serviceImageUrl: data.serviceImageUrl,
        displayOrder: data.displayOrder,
        newRow: data.newRow,
        isClosed: data.isClosed
      };

      // Update the category
      const res = await apiRequest("PATCH", `/api/categories/${category.id}`, submitData);
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(`Failed to update category: ${errorData.message || res.statusText}`);
      }

      // Success notification
      toast({
        title: "Success",
        description: `Updated ${data.isSubmenu ? "submenu" : "category"}: ${data.name}`,
      });

      // Refresh categories list
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: `Failed to update category: ${error.message}`,
        variant: "destructive"
      });
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 my-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
            name="displayOrder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display Order</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    onChange={(e) => field.onChange(parseInt(e.target.value))}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        {!category.isSubmenu && (
          <FormField
            control={form.control}
            name="parentId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Parent Menu</FormLabel>
                <FormDescription>
                  Choose which submenu this category belongs to
                </FormDescription>
                <FormControl>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={field.value || ""}
                    onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                  >
                    <option value="">Root (No Parent)</option>
                    {categories
                      ?.filter(cat => cat.isSubmenu && cat.id !== category.id)
                      .map(submenu => (
                        <option key={submenu.id} value={submenu.id}>{submenu.name}</option>
                      ))}
                  </select>
                </FormControl>
              </FormItem>
            )}
          />
        )}

        <div className="flex space-x-4">
          <FormField
            control={form.control}
            name="newRow"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2.5">
                <FormControl>
                  <div className="relative flex items-center">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={field.onChange}
                        id={`newRowCheckbox-${category.id}`}
                        className="peer sr-only"
                      />
                      <div className="h-5 w-5 rounded border border-gray-300 bg-white peer-checked:bg-primary peer-checked:border-primary transition-colors"></div>
                      {field.value && (
                        <Check className="h-3.5 w-3.5 text-white absolute top-[3px] left-[3px]" />
                      )}
                    </div>
                  </div>
                </FormControl>
                <FormLabel htmlFor={`newRowCheckbox-${category.id}`} className="m-0 font-medium cursor-pointer select-none">
                  Start New Row
                </FormLabel>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="isClosed"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2.5">
                <FormControl>
                  <div className="relative flex items-center">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={field.onChange}
                        id={`isClosedCheckbox-${category.id}`}
                        className="peer sr-only"
                      />
                      <div className="h-5 w-5 rounded border border-gray-300 bg-white peer-checked:bg-primary peer-checked:border-primary transition-colors"></div>
                      {field.value && (
                        <Check className="h-3.5 w-3.5 text-white absolute top-[3px] left-[3px]" />
                      )}
                    </div>
                  </div>
                </FormControl>
                <FormLabel htmlFor={`isClosedCheckbox-${category.id}`} className="m-0 font-medium cursor-pointer select-none">
                  Service Closed
                </FormLabel>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="ml-0.5">
                      <Info className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>When closed, users will see a message saying</p>
                      <p>"This service is currently closed. Try again later."</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </FormItem>
            )}
          />
        </div>

        {!category.isSubmenu && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <FormField
                control={form.control}
                name="discordRoleId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discord Role</FormLabel>
                    <FormDescription>
                      Role that will be pinged for new tickets
                    </FormDescription>
                    <div className="flex gap-2 items-center">
                      <FormControl className="flex-1">
                        <select
                          className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        >
                          <option value="">Select a role</option>
                          {form.getValues("discordRoles")?.map((role: any) => (
                            <option key={role.id} value={role.id}>{role.name}</option>
                          ))}
                        </select>
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="discordCategoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discord Active Tickets Category</FormLabel>
                    <FormDescription>
                      Where new ticket channels are created
                    </FormDescription>
                    <FormControl>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value)}
                      >
                        <option value="">Select a category</option>
                        {form.getValues("discordCategories")?.map((category: any) => (
                          <option key={category.id} value={category.id}>{category.name}</option>
                        ))}
                      </select>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="transcriptCategoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discord Transcripts Category</FormLabel>
                    <FormDescription>
                      Where closed tickets are moved
                    </FormDescription>
                    <FormControl>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value)}
                      >
                        <option value="">Select a category</option>
                        {form.getValues("discordCategories")?.map((category: any) => (
                          <option key={category.id} value={category.id}>{category.name}</option>
                        ))}
                      </select>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="serviceSummary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Service Summary</FormLabel>
                  <FormDescription>
                    A brief description that will be shown to users. Markdown is supported.
                  </FormDescription>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={3}
                      value={field.value || ''}
                    />
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

            <FormField
              control={form.control}
              name="questions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Questions</FormLabel>
                  <FormDescription>
                    One question per line. These questions will be asked when a user selects this category.
                  </FormDescription>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={4}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </>
        )}

        <div className="flex justify-end space-x-2 mt-6">
          <Button 
            type="button" 
            variant="outline" 
            onClick={() => Promise.all([
              refreshRoles(form, toast),
              refreshCategories(form, toast)
            ])}
            className="flex items-center gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh Discord Data</span>
          </Button>
          <Button type="submit">Save Changes</Button>
        </div>
      </form>
    </Form>
  );
}