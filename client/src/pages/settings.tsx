import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

const categorySchema = z.object({
  name: z.string().min(1, "Name is required"),
  discordRoleId: z.string().min(1, "Discord Role ID is required"),
  discordCategoryId: z.string().min(1, "Discord Category ID is required"),
  questions: z.string().transform(str => str.split("\n").filter(q => q.trim()))
});

export default function Settings() {
  const { toast } = useToast();
  const form = useForm({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: "",
      discordRoleId: "",
      discordCategoryId: "",
      questions: ""
    }
  });

  async function onSubmit(data: z.infer<typeof categorySchema>) {
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });

      if (!res.ok) throw new Error("Failed to create category");

      toast({
        title: "Success",
        description: "Category created successfully"
      });

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

              <Button type="submit">Create Category</Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
