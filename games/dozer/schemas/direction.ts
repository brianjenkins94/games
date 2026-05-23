import { Enum } from "../../../util/enum";

// None = 0 so uninitialized TypedArray slots mean "no intent".
export const Direction = new Enum([
    "None",
    "Up",
    "Right",
    "Down",
    "Left"
]);
