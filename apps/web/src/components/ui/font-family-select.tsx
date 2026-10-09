import { DataSelect } from "./data-select";
import type { ComponentProps } from "react";
// The pattern is controlled by caller data, so real workspace dropdowns use the same styling.
export default function FontFamilySelect(props: ComponentProps<typeof DataSelect>) { return <DataSelect {...props} />; }
