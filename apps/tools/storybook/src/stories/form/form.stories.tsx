import type { Meta, StoryObj } from "@storybook/react";
import { useForm } from "react-hook-form";

import { Button } from "@weldsuite/ui/components/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@weldsuite/ui/components/form";
import { Input } from "@weldsuite/ui/components/input";

const meta = {
  title: "Form/Form",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

interface Values {
  email: string;
  kvkNumber: string;
}

/** A client-side rule: the message shows after a submit. */
function ClientValidation() {
  const form = useForm<Values>({ defaultValues: { email: "", kvkNumber: "" } });
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(() => undefined)} className="w-[320px] space-y-4">
        <FormField
          control={form.control}
          name="email"
          rules={{ required: "Enter an email address" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
              </FormControl>
              <FormDescription>The KvK sends its confirmation here.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  );
}

/**
 * A check the server made (`invalid` on `FormControl`): the control is
 * marked invalid and the message is linked to it, without a client rule.
 */
function ServerCheck() {
  const form = useForm<Values>({ defaultValues: { email: "", kvkNumber: "1234" } });
  return (
    <Form {...form}>
      <form className="w-[320px] space-y-4">
        <FormField
          control={form.control}
          name="kvkNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>KvK number</FormLabel>
              <FormControl invalid>
                <Input inputMode="numeric" autoComplete="off" {...field} />
              </FormControl>
              <FormMessage>Enter the eight-digit KvK number</FormMessage>
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}

export const WithClientValidation: Story = {
  render: () => <ClientValidation />,
};

export const WithServerCheck: Story = {
  render: () => <ServerCheck />,
};
