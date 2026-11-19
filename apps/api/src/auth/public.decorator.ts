import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "treepm:is-public";

/** Marca uma rota como pública. Toda rota sem este decorator exige sessão com organização. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
