import { LaunchProps } from "@raycast/api";
import { LogShiftForm } from "./forms";

export default function Command(props: LaunchProps<{ launchContext?: { planId?: string } }>) {
  return <LogShiftForm planId={props.launchContext?.planId} />;
}
