import { DesignJobView } from "@/components/design/DesignJobView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DesignJobView id={id} />;
}
