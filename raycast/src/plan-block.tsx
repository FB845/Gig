import { LaunchProps } from "@raycast/api";
import { PlanBlockForm } from "./forms";

export default function Command(props: LaunchProps<{ launchContext?: { date?: string; start?: string; end?: string; platform?: string } }>) {
  return <PlanBlockForm {...(props.launchContext || {})} />;
}
