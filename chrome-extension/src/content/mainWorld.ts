import { installDriver } from "./mainWorldDriver";
import { installDialogSuppressor } from "./mainWorldSuppressor";
installDriver(window);
installDialogSuppressor(window);
