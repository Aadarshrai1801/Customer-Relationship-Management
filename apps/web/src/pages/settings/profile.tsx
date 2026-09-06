import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { api, type DirectoryUser } from '../../lib/api';
import { queryClient, useAuth } from '../../lib/providers';
import { Button, Card, Field, FormError, Input } from '../../components/ui';
import { useToast } from '../../components/toast';

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  timezone: z.string().trim().min(1, 'Timezone is required').max(50),
});

type ProfileValues = z.infer<typeof profileSchema>;

export function ProfilePage(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const { notify } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    values: { name: user?.name ?? '', timezone: '' },
  });

  useEffect(() => {
    if (!user) return;
    api<DirectoryUser>(`/users/${user.id}`)
      .then((full) => {
        form.reset({ name: full.name, timezone: full.timezone });
      })
      .catch(() => undefined);
  }, [user, form]);

  const mutation = useMutation({
    mutationFn: (values: ProfileValues) =>
      api<DirectoryUser>(`/users/${user!.id}`, { method: 'PATCH', body: values }),
    onSuccess: async () => {
      await refresh();
      queryClient.invalidateQueries({ queryKey: ['me'] });
      notify('success', 'Profile updated');
    },
    onError: (err: unknown) => {
      setFormError(err instanceof Error ? err.message : 'Update failed');
    },
  });

  if (!user) return <p>Loading…</p>;

  return (
    <Card title="Profile" description="Your personal details in this workspace.">
      <form
        onSubmit={form.handleSubmit((v) => {
          setFormError(null);
          mutation.mutate(v);
        })}
        className="flex max-w-md flex-col gap-4"
        noValidate
      >
        <Field label="Email" htmlFor="profile-email">
          <Input id="profile-email" value={user.email} disabled aria-disabled />
        </Field>
        <Field label="Name" htmlFor="profile-name" error={form.formState.errors.name?.message}>
          <Input id="profile-name" {...form.register('name')} />
        </Field>
        <Field
          label="Timezone"
          htmlFor="profile-timezone"
          error={form.formState.errors.timezone?.message}
          hint="IANA timezone, e.g. America/New_York."
        >
          <Input id="profile-timezone" {...form.register('timezone')} />
        </Field>
        <FormError message={formError} />
        <div>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
