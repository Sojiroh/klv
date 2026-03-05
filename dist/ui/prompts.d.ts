export declare function select(message: string, choices: string[]): Promise<string>;
export declare function multiSelect(message: string, choices: string[]): Promise<string[]>;
export declare function confirm(message: string, defaultValue?: boolean): Promise<boolean>;
