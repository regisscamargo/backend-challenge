import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { UnitOfWork } from "../../../application/shared/unit-of-work";

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly entityManager: EntityManager) {}

  async execute<T>(
    work: (context: {
      readonly transactionId: string;
      readonly transaction: EntityManager;
    }) => Promise<T>,
  ): Promise<T> {
    const fork = this.entityManager.fork();

    return fork.transactional(async (transactionalEntityManager) =>
      work({
        transactionId: randomUUID(),
        transaction: transactionalEntityManager,
      }),
    );
  }
}
