import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Trash2, Plus, Settings } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface AdminRole {
  id: number;
  roleName: string;
  discordRoleId: string;
  isFullAdmin: boolean;
  createdAt: string;
  createdBy: string;
}

interface Category {
  id: number;
  name: string;
}

interface RolePermissions {
  roleId: number;
  categoryIds: number[];
}

const AdminRolesPage: React.FC = () => {
  const [newRole, setNewRole] = useState({
    roleName: '',
    discordRoleId: '',
    isFullAdmin: false,
    createdBy: 'System' // You might want to get this from auth context
  });
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const queryClient = useQueryClient();

  // Fetch admin roles
  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: async () => {
      const response = await fetch('/api/admin-roles');
      if (!response.ok) throw new Error('Failed to fetch admin roles');
      return response.json() as Promise<AdminRole[]>;
    }
  });

  // Fetch categories
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const response = await fetch('/api/categories');
      if (!response.ok) throw new Error('Failed to fetch categories');
      return response.json() as Promise<Category[]>;
    }
  });

  // Create role mutation
  const createRoleMutation = useMutation({
    mutationFn: async (roleData: typeof newRole) => {
      const response = await fetch('/api/admin-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roleData)
      });
      if (!response.ok) throw new Error('Failed to create admin role');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      setNewRole({ roleName: '', discordRoleId: '', isFullAdmin: false, createdBy: 'System' });
      setShowCreateForm(false);
      toast({ title: 'Admin role created successfully' });
    },
    onError: (error) => {
      toast({ title: 'Error creating admin role', description: error.message, variant: 'destructive' });
    }
  });

  // Delete role mutation
  const deleteRoleMutation = useMutation({
    mutationFn: async (roleId: number) => {
      const response = await fetch(`/api/admin-roles/${roleId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete admin role');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      toast({ title: 'Admin role deleted successfully' });
    },
    onError: (error) => {
      toast({ title: 'Error deleting admin role', description: error.message, variant: 'destructive' });
    }
  });

  const handleCreateRole = () => {
    if (!newRole.roleName || !newRole.discordRoleId) {
      toast({ title: 'Please fill in all required fields', variant: 'destructive' });
      return;
    }
    createRoleMutation.mutate(newRole);
  };

  const handleDeleteRole = (roleId: number) => {
    if (confirm('Are you sure you want to delete this admin role?')) {
      deleteRoleMutation.mutate(roleId);
    }
  };

  if (rolesLoading) {
    return <div className="p-6">Loading admin roles...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Admin Roles</h1>
          <p className="text-muted-foreground">Manage Discord role-based permissions</p>
        </div>
        <Button onClick={() => setShowCreateForm(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Create Role
        </Button>
      </div>

      {/* Create Role Form */}
      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle>Create New Admin Role</CardTitle>
            <CardDescription>Create a new Discord role with specific category permissions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="roleName">Role Name</Label>
                <Input
                  id="roleName"
                  value={newRole.roleName}
                  onChange={(e) => setNewRole({ ...newRole, roleName: e.target.value })}
                  placeholder="e.g., UberEats Admin"
                />
              </div>
              <div>
                <Label htmlFor="discordRoleId">Discord Role ID</Label>
                <Input
                  id="discordRoleId"
                  value={newRole.discordRoleId}
                  onChange={(e) => setNewRole({ ...newRole, discordRoleId: e.target.value })}
                  placeholder="Discord role ID"
                />
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="isFullAdmin"
                checked={newRole.isFullAdmin}
                onCheckedChange={(checked) => setNewRole({ ...newRole, isFullAdmin: checked })}
              />
              <Label htmlFor="isFullAdmin">Full Admin (can access all categories)</Label>
            </div>
            <div className="flex space-x-2">
              <Button onClick={handleCreateRole} disabled={createRoleMutation.isPending}>
                {createRoleMutation.isPending ? 'Creating...' : 'Create Role'}
              </Button>
              <Button variant="outline" onClick={() => setShowCreateForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Roles List */}
      <div className="grid gap-4">
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            categories={categories}
            onDelete={() => handleDeleteRole(role.id)}
          />
        ))}
      </div>

      {roles.length === 0 && (
        <Card>
          <CardContent className="text-center py-8">
            <p className="text-muted-foreground">No admin roles created yet.</p>
            <Button onClick={() => setShowCreateForm(true)} className="mt-4">
              <Plus className="w-4 h-4 mr-2" />
              Create Your First Role
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

interface RoleCardProps {
  role: AdminRole;
  categories: Category[];
  onDelete: () => void;
}

const RoleCard: React.FC<RoleCardProps> = ({ role, categories, onDelete }) => {
  const [permissions, setPermissions] = useState<number[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const queryClient = useQueryClient();

  // Fetch role permissions
  const { data: rolePermissions } = useQuery({
    queryKey: ['role-permissions', role.id],
    queryFn: async () => {
      const response = await fetch(`/api/admin-roles/${role.id}/permissions`);
      if (!response.ok) throw new Error('Failed to fetch role permissions');
      return response.json() as Promise<RolePermissions>;
    }
  });

  // Update permissions mutation
  const updatePermissionsMutation = useMutation({
    mutationFn: async (categoryIds: number[]) => {
      const response = await fetch(`/api/admin-roles/${role.id}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryIds })
      });
      if (!response.ok) throw new Error('Failed to update permissions');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-permissions', role.id] });
      setIsEditing(false);
      toast({ title: 'Permissions updated successfully' });
    },
    onError: (error) => {
      toast({ title: 'Error updating permissions', description: error.message, variant: 'destructive' });
    }
  });

  useEffect(() => {
    if (rolePermissions) {
      setPermissions(rolePermissions.categoryIds);
    }
  }, [rolePermissions]);

  const handleSavePermissions = () => {
    updatePermissionsMutation.mutate(permissions);
  };

  const toggleCategory = (categoryId: number) => {
    setPermissions(prev => 
      prev.includes(categoryId) 
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  const allowedCategories = categories.filter(cat => permissions.includes(cat.id));

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              {role.roleName}
              {role.isFullAdmin && <Badge variant="default">Full Admin</Badge>}
            </CardTitle>
            <CardDescription>
              Discord Role ID: {role.discordRoleId}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(!isEditing)}
            >
              <Settings className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {role.isFullAdmin ? (
          <p className="text-sm text-muted-foreground">
            Full admin - can access all categories
          </p>
        ) : (
          <div>
            <p className="text-sm font-medium mb-2">Allowed Categories:</p>
            {isEditing ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {categories.map((category) => (
                    <label key={category.id} className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={permissions.includes(category.id)}
                        onChange={() => toggleCategory(category.id)}
                        className="rounded"
                      />
                      <span className="text-sm">{category.name}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSavePermissions}>
                    Save
                  </Button>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => {
                      setIsEditing(false);
                      setPermissions(rolePermissions?.categoryIds || []);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {allowedCategories.length > 0 ? (
                  allowedCategories.map((category) => (
                    <Badge key={category.id} variant="secondary">
                      {category.name}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No categories assigned</span>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default AdminRolesPage;
