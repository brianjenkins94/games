import { Types } from 'bitecs'
import { Enum } from '../../../util/enum';

export const schema = {
	"texture": Types.ui8
}

export const Textures = new Enum([
	"TankBlue",
	"TankGreen",
	"TankRed"
]);