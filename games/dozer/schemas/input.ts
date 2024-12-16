import { Types } from "bitecs"
import { Enum } from "../../../util/enum";

export const schema = {
	direction: Types.ui8
}

export const Direction = new Enum([
	"Up",
	"Right",
	"Down",
	"Left"
]);
